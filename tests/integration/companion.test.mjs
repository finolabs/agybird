import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
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

test('cancel ends a provider process that ignores SIGTERM', { skip: process.platform === 'win32' && 'taskkill /F is forced already' }, async () => {
  const env = companionEnv();
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-c-ws-'));
  const launch = json(await runCompanion(['task', '--background', '--json', 'CASE_STUBBORN keep running'], { env, cwd }));
  const pidFile = join(cwd, 'fake-agy.pid');
  const agyPid = await waitFor(() => (existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : null));
  json(await runCompanion(['cancel', launch.job.id, '--json'], { env, cwd }));
  const gone = await waitFor(() => {
    try {
      process.kill(agyPid, 0);
      return null;
    } catch {
      return true;
    }
  }, 10_000);
  assert.equal(gone, true);
});

test('cancel never signals a recorded pid whose worker is gone', async () => {
  const env = companionEnv();
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-c-ws-'));
  // An unrelated process that happens to hold the pid the record names.
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: process.platform !== 'win32', stdio: 'ignore' });
  try {
    const { workspaceDirectory, workspaceRoot, writeJob, newJobId } = await import('../../scripts/lib/jobs.mjs');
    const directory = workspaceDirectory(workspaceRoot(cwd), env);
    const stale = new Date(Date.now() - 5_000).toISOString();
    const id = newJobId();
    writeJob(directory, { id, kind: 'task', status: 'running', pid: bystander.pid, runnerPid: bystander.pid, createdAt: stale, heartbeatAt: new Date(Date.now() - 120_000).toISOString(), timeoutMs: 600_000 });
    const result = json(await runCompanion(['cancel', id, '--json'], { env, cwd }));
    assert.equal(result.stopped, false);
    process.kill(bystander.pid, 0);
  } finally {
    bystander.kill('SIGKILL');
  }
});

test('a failure right after spawn stops the runner before reporting', async () => {
  const { runRunner } = await import('../../scripts/companion.mjs');
  const workspace = mkdtempSync(join(tmpdir(), 'agybird-c-ws-'));
  let runnerPid;
  await assert.rejects(
    runRunner({
      workspace,
      env: companionEnv(),
      request: { category: 'code', mode: 'read', timeout: '30s', runnerArgs: [], prompt: 'CASE_HANG forever' },
      onSpawn: (child) => {
        runnerPid = child.pid;
        throw new Error('registration failed');
      },
    }),
    /registration failed/,
  );
  assert.throws(() => process.kill(runnerPid, 0), /ESRCH/, 'the runner must be gone once runRunner rejects');
});

test('slash commands never splice $ARGUMENTS into inline shell', () => {
  for (const name of readdirSync(join(projectRoot, 'commands'))) {
    const text = readFileSync(join(projectRoot, 'commands', name), 'utf8');
    for (const line of text.split('\n').filter((entry) => entry.includes('!`'))) {
      assert.doesNotMatch(line, /\$ARGUMENTS|\$\d/, `${name} splices arguments into a shell line`);
    }
  }
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
