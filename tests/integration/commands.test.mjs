import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { companionEnv, runCompanion } from './helpers.mjs';

function parsed(run) {
  assert.equal(run.code, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test('usage lists each limit and the model each tier would use now', async () => {
  const usage = parsed(await runCompanion(['usage', '--json']));
  assert.equal(usage.limits.length, 5);
  assert.equal(usage.picks.standard, 'claude-sonnet-5-5-medium');
  assert.equal(usage.picks.light, 'claude-sonnet-5-5-low');
  const text = await runCompanion(['usage']);
  assert.match(text.stdout, /Gemini 4 Argon/);
});

test('setup reports agy and switches the review gate for this workspace only', async () => {
  const env = companionEnv();
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-setup-'));
  const first = parsed(await runCompanion(['setup', '--json'], { env, cwd }));
  assert.match(first.agy.version, /0\.0\.0-fake/);
  assert.equal(first.signedIn, true);
  assert.equal(first.reviewGate, false);
  assert.equal(parsed(await runCompanion(['setup', '--enable-review-gate', '--json'], { env, cwd })).reviewGate, true);
  assert.equal(parsed(await runCompanion(['setup', '--json'], { env, cwd })).reviewGate, true);
  const other = mkdtempSync(join(tmpdir(), 'agybird-setup-'));
  assert.equal(parsed(await runCompanion(['setup', '--json'], { env, cwd: other })).reviewGate, false);
  assert.equal(parsed(await runCompanion(['setup', '--disable-review-gate', '--json'], { env, cwd })).reviewGate, false);
});

test('a task without --model runs on the standard tier model with the most room', async () => {
  const result = parsed(await runCompanion(['task', '--json', 'CASE_ECHO_MODEL']));
  assert.equal(result.envelope.response, 'claude-sonnet-5-5-medium');
  assert.equal(result.job.model, 'claude-sonnet-5-5-medium');
});

test('a model the user names is used as is', async () => {
  const result = parsed(await runCompanion(['task', '--json', '--model', 'gemini-3.8-flash-low', 'CASE_ECHO_MODEL']));
  assert.equal(result.envelope.response, 'gemini-3.8-flash-low');
});

test('with the tier spent the task stops and names the reset time instead of moving up', async () => {
  const spent = ['Gemini Models\tWeekly Limit Remaining\t0%\t2026-11-14T09:54:37Z', 'Claude and GPT models\tWeekly Limit Remaining\t0%\t2026-11-17T16:40:15Z'].join('\n');
  const run = await runCompanion(['task', 'CASE_ECHO_MODEL'], { env: companionEnv({ FAKE_AGY_USAGE: spent }) });
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /standard tier/);
  assert.match(run.stderr, /Limits reset: Gemini Models/);
});

test('image generates an image and lists the verified artifact', async () => {
  const run = await runCompanion(['image', 'CASE_IMAGE_SUCCESS a small blue bird']);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /generated\.png/);
});
