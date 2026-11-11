// Job store for companion runs: one JSON record and one log per job, kept per
// workspace outside the repository. A record is the only shared state between
// the process that starts a job, the detached worker, and later status calls.

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
// A worker that outlives its own timeout by this much is treated as gone.
const STALE_GRACE_MS = 60_000;

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

export function updateJob(directory, id, patch) {
  const current = readJob(directory, id);
  if (!current) throw new Error(`Unknown job: ${id}`);
  // A cancelled job stays cancelled even if its worker reports in afterwards.
  if (current.status === 'cancelled' && patch.status && patch.status !== 'cancelled') return current;
  return writeJob(directory, { ...current, ...patch });
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
  if (job.status === 'running' && !alive(job.pid)) return 'failed';
  if (Number.isFinite(deadline) && now > deadline) return 'failed';
  return job.status;
}

// Settles a record whose worker is gone, so the store stops reporting it as live.
export function reconcile(directory, job, now = Date.now(), alive = processAlive) {
  const status = effectiveStatus(job, now, alive);
  if (status === job.status) return job;
  return updateJob(directory, job.id, {
    status,
    finishedAt: new Date(now).toISOString(),
    error: job.error ?? 'The background worker stopped without reporting a result.',
  });
}

// Stops a worker and everything it started. A detached POSIX worker leads its own
// process group, so the group signal also reaches the runner and agy.
export function killTree(pid, platform = process.platform) {
  if (!processAlive(pid)) return false;
  if (platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true });
    return result.status === 0;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return false;
    }
  }
  return true;
}
