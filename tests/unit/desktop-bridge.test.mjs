import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { AX_SCRIPT_PATH, callBridge } from '../../scripts/lib/desktop-bridge.mjs';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-desktop-bridge.mjs');

function fake(state = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'agybird-desktop-')), 'state.json');
  writeFileSync(file, JSON.stringify(state));
  return {
    env: { ...process.env, AGYBIRD_DESKTOP_BRIDGE: FAKE, AGYBIRD_FAKE_DESKTOP_STATE: file },
    state: () => JSON.parse(readFileSync(file, 'utf8')),
  };
}

test('the wrapper returns each command\'s JSON line', async () => {
  const { env, state } = fake({ sent: true, runningPolls: 1, reply: 'READY' });
  assert.deepEqual(await callBridge(['probe'], { env }), { trusted: true, pid: 4242, version: '2.35.2', frontmost: 'com.example.host' });
  assert.equal((await callBridge(['snapshot'], { env })).running, true);
  const done = await callBridge(['snapshot'], { env });
  assert.deepEqual([done.running, done.reply, done.preset], [false, 'READY', 'Request Review']);
  assert.deepEqual(await callBridge(['new-conversation', 'agybird'], { env }), { ok: true });
  assert.deepEqual(state().calls.map((call) => call[0]), ['probe', 'snapshot', 'snapshot', 'new-conversation']);
});

test('a non-zero exit, bad JSON, an error field or a hang becomes an error', async () => {
  await assert.rejects(callBridge(['probe'], fake({ exit: 3 })), /probe.*exited with 3/);
  await assert.rejects(callBridge(['probe'], fake({ raw: 'not json' })), /probe.*not JSON/);
  await assert.rejects(callBridge(['snapshot'], fake({ trusted: false })), /snapshot.*not_trusted/);
  await assert.rejects(callBridge(['probe'], { ...fake({ hang: true }), timeoutMs: 300 }), /probe.*timed out/);
});

const DIALOG_QUESTION = 'Allow list directory contents?';

test('the wrapper refuses every dialog answer but option 1 and Skip, without calling the bridge', async () => {
  const { env, state } = fake({ sent: true, dialog: { question: DIALOG_QUESTION, options: ['1 Yes, allow this time'] } });
  for (const option of ['2', '3', '4', 'Submit', '']) {
    await assert.rejects(callBridge(['answer', option], { env }), /only 1 or Skip/);
  }
  assert.equal(state().calls, undefined, 'the bridge was never started');
  await assert.rejects(callBridge(['answer', '1'], { env }), /question and conversation/);
  assert.deepEqual(await callBridge(['answer', '1', DIALOG_QUESTION, 'Fake Task - workspace - Antigravity'], { env }), { ok: true });
});

test('the AX script sends no keystrokes and answers only option 1 or Skip', () => {
  const source = readFileSync(AX_SCRIPT_PATH, 'utf8');
  assert.doesNotMatch(source, /keystroke\(|key code|keyCode|CGEvent/i);
  assert.match(source, /const OPTION_1 = '1 Yes, allow this time';/);
  assert.doesNotMatch(source, /AXRadioButton', '[234] /);
  assert.doesNotMatch(source, /press\(find\([^)]*'AXPopUpButton'/, 'no selector, the permissions preset included, is ever changed');
});
