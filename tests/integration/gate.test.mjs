import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { companionEnv, runCompanion } from './helpers.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function repository(change) {
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-gate-'));
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'Test');
  writeFileSync(join(cwd, 'a.txt'), 'one\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', 'base');
  if (change) writeFileSync(join(cwd, 'a.txt'), `one\n${change}\n`);
  return cwd;
}

async function gate({ cwd, env = companionEnv(), input = {}, enable = true }) {
  if (enable) assert.equal((await runCompanion(['setup', '--enable-review-gate'], { env, cwd })).code, 0);
  const run = await runCompanion(['hook', 'stop'], { env, cwd, input: JSON.stringify({ hook_event_name: 'Stop', cwd, stop_hook_active: false, last_assistant_message: 'Done.', ...input }) });
  return { ...run, env };
}

function jobCount(env) {
  if (!existsSync(env.AGYBIRD_JOBS_DIR)) return 0;
  return readdirSync(env.AGYBIRD_JOBS_DIR, { recursive: true }).filter((name) => String(name).endsWith('.json') && String(name).includes('job-')).length;
}

test('with the gate off the hook starts nothing', async () => {
  const run = await gate({ cwd: repository('CASE_REVIEW change'), enable: false });
  assert.equal(run.code, 0);
  assert.equal(run.stdout.trim(), '');
  assert.equal(jobCount(run.env), 0);
});

test('with no changes the hook starts nothing', async () => {
  const run = await gate({ cwd: repository() });
  assert.equal(run.code, 0);
  assert.equal(run.stdout.trim(), '');
  assert.equal(jobCount(run.env), 0);
});

test('a medium finding blocks the stop with the findings as the reason', async () => {
  const run = await gate({ cwd: repository('CASE_REVIEW change') });
  assert.equal(run.code, 0, run.stderr);
  const decision = JSON.parse(run.stdout);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /MEDIUM\*\* Saw the diff/);
});

test('only low findings let the stop pass', async () => {
  const run = await gate({ cwd: repository('CASE_GATE_CLEAN change') });
  assert.equal(run.code, 0, run.stderr);
  const output = run.stdout.trim() ? JSON.parse(run.stdout) : {};
  assert.notEqual(output.decision, 'block');
});

test('the hook never blocks twice in a row', async () => {
  const run = await gate({ cwd: repository('CASE_REVIEW change'), input: { stop_hook_active: true } });
  assert.equal(run.code, 0);
  assert.equal(run.stdout.trim(), '');
});

test('without agy the hook lets the stop pass with a notice', async () => {
  const env = companionEnv({ PATH: '/usr/bin:/bin' });
  const cwd = repository('CASE_REVIEW change');
  const run = await gate({ cwd, env });
  assert.equal(run.code, 0);
  const output = JSON.parse(run.stdout);
  assert.notEqual(output.decision, 'block');
  assert.match(output.systemMessage, /Agybird review gate skipped/);
});

test('a malformed hook input lets the stop pass', async () => {
  const env = companionEnv();
  const cwd = repository('CASE_REVIEW change');
  await runCompanion(['setup', '--enable-review-gate'], { env, cwd });
  const run = await runCompanion(['hook', 'stop'], { env, cwd, input: 'not json' });
  assert.equal(run.code, 0);
  assert.notEqual(run.stdout.trim() ? JSON.parse(run.stdout).decision : undefined, 'block');
});
