import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

test('without a light-tier model the gate skips instead of running the default model', async () => {
  const env = companionEnv({ FAKE_AGY_MODELS: 'other-model-x\tOther Model\n' });
  const run = await gate({ cwd: repository('CASE_REVIEW change'), env });
  assert.equal(run.code, 0);
  assert.match(JSON.parse(run.stdout).systemMessage, /light/);
  assert.equal(jobCount(env), 0);
});

test('past its deadline the gate stops agy and lets the stop pass', { skip: process.platform === 'win32' && 'POSIX signals' }, async () => {
  const env = companionEnv({ AGYBIRD_GATE_DEADLINE_MS: '3000' });
  const cwd = repository('CASE_STUBBORN change');
  const started = Date.now();
  const run = await gate({ cwd, env });
  assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started}ms`);
  assert.equal(run.code, 0);
  assert.match(JSON.parse(run.stdout).systemMessage, /did not finish/);
  const pidFile = join(cwd, 'fake-agy.pid');
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), /ESRCH/, 'agy must be stopped');
  }
});

test('a git that hangs cannot hold the hook past its deadline', { skip: process.platform === 'win32' && 'uses a POSIX shell script as git' }, async () => {
  const cwd = repository('CASE_REVIEW change');
  const realEnv = companionEnv();
  assert.equal((await runCompanion(['setup', '--enable-review-gate'], { env: realEnv, cwd })).code, 0);
  const stall = mkdtempSync(join(tmpdir(), 'agybird-stall-'));
  writeFileSync(join(stall, 'git'), '#!/bin/sh\nsleep 120\n', { mode: 0o755 });
  const env = { ...realEnv, PATH: `${stall}:${realEnv.PATH}`, AGYBIRD_GATE_DEADLINE_MS: '3000', AGYBIRD_GIT_TIMEOUT_MS: '1000' };
  const started = Date.now();
  const run = await runCompanion(['hook', 'stop'], { env, cwd, input: JSON.stringify({ hook_event_name: 'Stop', cwd, stop_hook_active: false }) });
  assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started}ms`);
  assert.equal(run.code, 0);
  assert.notEqual(run.stdout.trim() ? JSON.parse(run.stdout).decision : undefined, 'block');
});

test('a job that cannot be created ends the hook at once with a notice', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'needs POSIX permissions as a normal user' }, async () => {
  const env = companionEnv();
  const cwd = repository('CASE_REVIEW change');
  assert.equal((await runCompanion(['setup', '--enable-review-gate'], { env, cwd })).code, 0);
  assert.equal((await runCompanion(['usage', '--json'], { env, cwd })).code, 0);
  const store = readdirSync(env.AGYBIRD_JOBS_DIR).map((name) => join(env.AGYBIRD_JOBS_DIR, name)).find((path) => !path.endsWith('.json'));
  chmodSync(store, 0o500);
  try {
    const started = Date.now();
    const run = await runCompanion(['hook', 'stop'], { env, cwd, input: JSON.stringify({ hook_event_name: 'Stop', cwd, stop_hook_active: false }) });
    assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started}ms`);
    assert.match(JSON.parse(run.stdout).systemMessage, /skipped/);
  } finally {
    chmodSync(store, 0o700);
  }
});
