import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const companionPath = join(projectRoot, 'scripts', 'companion.mjs');
const fakeBin = mkdtempSync(join(tmpdir(), 'agybird-companion-bin-'));
const fakeCommandPath = join(fakeBin, 'agy');
copyFileSync(join(projectRoot, 'tests', 'fixtures', 'fake-agy.mjs'), fakeCommandPath);
chmodSync(fakeCommandPath, 0o755);

export function companionEnv(extra = {}) {
  return {
    ...process.env,
    PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
    AGYBIRD_PROJECTS_DIR: mkdtempSync(join(tmpdir(), 'agybird-c-projects-')),
    AGYBIRD_STATE_DIR: mkdtempSync(join(tmpdir(), 'agybird-c-state-')),
    AGYBIRD_JOBS_DIR: mkdtempSync(join(tmpdir(), 'agybird-c-jobs-')),
    ...extra,
  };
}

export function runCompanion(args, { env = companionEnv(), cwd = mkdtempSync(join(tmpdir(), 'agybird-c-ws-')), input = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [companionPath, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, cwd, env }));
    child.stdin.end(input);
  });
}

async function waitFor(check, timeoutMs = 15_000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await new Promise((done) => setTimeout(done, 200));
  }
}

function json(result) {
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('status is empty for a workspace with no jobs', async () => {
  const status = json(await runCompanion(['status', '--json']));
  assert.deepEqual(status.jobs, []);
});

test('a foreground task returns the result and is listed as completed', async () => {
  const run = await runCompanion(['task', '--json', 'CASE_SUCCESS please inspect']);
  const result = json(run);
  assert.equal(result.job.status, 'completed');
  assert.equal(result.envelope.status, 'success');
  const status = json(await runCompanion(['status', '--json'], { env: run.env, cwd: run.cwd }));
  assert.equal(status.jobs[0].id, result.job.id);
  assert.equal(status.jobs[0].status, 'completed');
});

test('a background task returns at once and finishes later', async () => {
  const env = companionEnv();
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-c-ws-'));
  const started = Date.now();
  const launch = json(await runCompanion(['task', '--background', '--json', 'CASE_DELAY then answer'], { env, cwd }));
  assert.ok(Date.now() - started < 1_900, 'background launch must not wait for agy');
  assert.match(launch.job.status, /queued|running/);
  const done = await waitFor(async () => {
    const snapshot = json(await runCompanion(['status', launch.job.id, '--json'], { env, cwd }));
    return snapshot.job.status === 'completed' ? snapshot : null;
  });
  assert.equal(done.job.outcome, 'success');
  const result = json(await runCompanion(['result', launch.job.id, '--json'], { env, cwd }));
  assert.equal(result.envelope.response, 'too late');
});

test('cancel stops a background job and it stays cancelled', async () => {
  const env = companionEnv();
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-c-ws-'));
  const launch = json(await runCompanion(['task', '--background', '--json', 'CASE_HANG forever'], { env, cwd }));
  await waitFor(async () => json(await runCompanion(['status', launch.job.id, '--json'], { env, cwd })).job.status === 'running');
  const cancelled = json(await runCompanion(['cancel', launch.job.id, '--json'], { env, cwd }));
  assert.equal(cancelled.job.status, 'cancelled');
  await new Promise((done) => setTimeout(done, 1_000));
  assert.equal(json(await runCompanion(['status', launch.job.id, '--json'], { env, cwd })).job.status, 'cancelled');
});

test('result and cancel refuse an unknown job id', async () => {
  const result = await runCompanion(['result', 'job-zzz-000000']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /No job job-zzz-000000/);
});

test('slash-command arguments arrive as one string and are split', async () => {
  const result = json(await runCompanion(['status --json']));
  assert.deepEqual(result.jobs, []);
});
