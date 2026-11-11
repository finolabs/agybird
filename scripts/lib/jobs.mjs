// Job store for companion runs: one JSON record and one log per job, kept per
// workspace outside the repository. A record is the only shared state between
// the process that starts a job, the detached worker, and later status calls.

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
// A worker that outlives its own timeout by this much is treated as gone.
const STALE_GRACE_MS = 60_000;
// A live worker refreshes heartbeatAt this often; a beat older than the limit
// means the worker is gone, whatever process now holds its pid.
export const HEARTBEAT_MS = 10_000;
const HEARTBEAT_LIMIT_MS = 45_000;
// A lock older than this was left by a process that died holding it.
const STALE_LOCK_MS = 30_000;

export function jobsRoot(env = process.env) {
  if (env.AGYBIRD_JOBS_DIR) return env.AGYBIRD_JOBS_DIR;
  const pluginData = env.CLAUDE_PLUGIN_DATA || env.PLUGIN_DATA;
  if (pluginData) return join(pluginData, 'jobs');
  return join(homedir(), '.agybird', 'jobs');
}

export function workspaceRoot(cwd) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  const top = result.status === 0 ? result.stdout.trim() : '';
  return realpathSync(top || cwd);
}

export function workspaceDirectory(workspace, env = process.env) {
  const key = createHash('sha256').update(workspace).digest('hex').slice(0, 16);
  return join(jobsRoot(env), key);
}

export function newJobId(now = Date.now()) {
  return `job-${now.toString(36)}-${randomBytes(3).toString('hex')}`;
}

const JOB_ID = /^job-[0-9a-z]+-[0-9a-f]{6}$/;

export function isJobId(value) {
  return typeof value === 'string' && JOB_ID.test(value);
}

function recordPath(directory, id) {
  return join(directory, `${id}.json`);
}

export function logPath(directory, id) {
  return join(directory, `${id}.log`);
}

export function writeJob(directory, job) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = recordPath(directory, job.id);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return job;
}

export function readJob(directory, id) {
  if (!isJobId(id)) throw new Error(`Invalid job id: ${id}`);
  const path = recordPath(directory, id);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

// Every state change runs under one lock file per job, so a read, a decision and
// a write cannot interleave with another process doing the same.
export function withJobLock(directory, id, action, { timeoutMs = 5_000 } = {}) {
  if (!isJobId(id)) throw new Error(`Invalid job id: ${id}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, `${id}.lock`);
  const started = Date.now();
  let descriptor;
  for (;;) {
    try {
      descriptor = openSync(lock, 'wx', 0o600);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { force: true });
      } catch {
        // removed by its owner meanwhile
      }
      if (Date.now() - started > timeoutMs) throw new Error(`Job ${id} is locked by another process`);
      sleep(25);
    }
  }
  try {
    return action();
  } finally {
    closeSync(descriptor);
    rmSync(lock, { force: true });
  }
}

export function updateJob(directory, id, patch) {
  return withJobLock(directory, id, () => {
    const current = readJob(directory, id);
    if (!current) throw new Error(`Unknown job: ${id}`);
    // A cancelled job stays cancelled even if its worker reports in afterwards.
    if (current.status === 'cancelled' && patch.status && patch.status !== 'cancelled') return current;
    return writeJob(directory, { ...current, ...patch });
  });
}

// The one way a worker may start a job: only a queued job moves to running, so a
// job cancelled before its worker got to it never reaches the runner.
export function claimJob(directory, id, pid, now = Date.now()) {
  return withJobLock(directory, id, () => {
    const current = readJob(directory, id);
    if (!current || current.status !== 'queued') return null;
    const stamp = new Date(now).toISOString();
    return writeJob(directory, { ...current, status: 'running', pid, startedAt: stamp, heartbeatAt: stamp });
  });
}

// Cancels under the lock and returns the record as it was, so the caller knows
// which processes to stop. A job that already ended is returned unchanged.
export function markCancelled(directory, id, now = Date.now()) {
  return withJobLock(directory, id, () => {
    const current = readJob(directory, id);
    if (!current) throw new Error(`Unknown job: ${id}`);
    if (TERMINAL_STATES.has(current.status)) return { before: current, after: current };
    const after = writeJob(directory, { ...current, status: 'cancelled', finishedAt: new Date(now).toISOString() });
    return { before: current, after };
  });
}

export function heartbeatFresh(job, now = Date.now()) {
  const beat = Date.parse(job.heartbeatAt ?? '');
  return Number.isFinite(beat) && now - beat <= HEARTBEAT_LIMIT_MS;
}

export function listJobs(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json') && isJobId(name.slice(0, -5)))
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(directory, name), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// The status a reader should believe. A running record whose worker has died,
// or that has run past its own deadline, can never finish on its own.
export function effectiveStatus(job, now = Date.now(), alive = processAlive) {
  if (TERMINAL_STATES.has(job.status)) return job.status;
  const deadline = Date.parse(job.createdAt) + (job.timeoutMs ?? 0) + STALE_GRACE_MS;
  // The heartbeat decides; a pid alone can belong to an unrelated process by now.
  if (job.status === 'running' && (job.heartbeatAt ? !heartbeatFresh(job, now) : !alive(job.pid))) return 'failed';
  if (Number.isFinite(deadline) && now > deadline) return 'failed';
  return job.status;
}

// Settles a record whose worker is gone, so the store stops reporting it as live.
export function reconcile(directory, job, now = Date.now(), alive = processAlive) {
  if (effectiveStatus(job, now, alive) === job.status) return job;
  return withJobLock(directory, job.id, () => {
    const current = readJob(directory, job.id);
    if (!current || effectiveStatus(current, now, alive) === current.status) return current;
    return writeJob(directory, {
      ...current,
      status: 'failed',
      finishedAt: new Date(now).toISOString(),
      error: current.error ?? 'The worker stopped without reporting a result.',
    });
  });
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Stops a process group led by `pid` (the runner, which agy belongs to):
// SIGTERM, a bounded wait, then SIGKILL. Returns true once nothing is left.
// Windows has no groups; taskkill /T /F ends the whole tree at once.
export function killTree(pid, { platform = process.platform, graceMs = 3_000 } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (platform === 'win32') {
    if (!processAlive(pid)) return true;
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true });
    return result.status === 0 || !processAlive(pid);
  }
  if (!groupAlive(pid)) return true;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return !groupAlive(pid);
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!groupAlive(pid)) return true;
    sleep(100);
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
  sleep(100);
  return !groupAlive(pid);
}
