import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  effectiveStatus,
  isJobId,
  jobsRoot,
  listJobs,
  newJobId,
  readJob,
  reconcile,
  updateJob,
  writeJob,
} from '../../scripts/lib/jobs.mjs';

const dead = () => false;
const alive = () => true;

function store() {
  return mkdtempSync(join(tmpdir(), 'agybird-jobs-'));
}

test('job ids are unique and validated', () => {
  const id = newJobId();
  assert.ok(isJobId(id));
  assert.notEqual(id, newJobId());
  assert.equal(isJobId('../etc/passwd'), false);
  assert.throws(() => readJob(store(), '../x'), /Invalid job id/);
});

test('the store root follows plugin data, then the home folder', () => {
  assert.equal(jobsRoot({ CLAUDE_PLUGIN_DATA: '/data' }), join('/data', 'jobs'));
  assert.equal(jobsRoot({ PLUGIN_DATA: '/codex' }), join('/codex', 'jobs'));
  assert.equal(jobsRoot({ AGYBIRD_JOBS_DIR: '/x', CLAUDE_PLUGIN_DATA: '/data' }), '/x');
});

test('a running job whose worker died reads as failed and is settled', () => {
  const directory = store();
  const job = writeJob(directory, { id: newJobId(), status: 'running', pid: 4242, createdAt: new Date().toISOString(), timeoutMs: 60_000 });
  assert.equal(effectiveStatus(job, Date.now(), alive), 'running');
  assert.equal(effectiveStatus(job, Date.now(), dead), 'failed');
  const settled = reconcile(directory, job, Date.now(), dead);
  assert.equal(settled.status, 'failed');
  assert.equal(readJob(directory, job.id).status, 'failed');
});

test('a job past its deadline reads as failed even if a process holds its pid', () => {
  const created = Date.now() - 10 * 60_000;
  const job = { id: newJobId(), status: 'running', pid: 1, createdAt: new Date(created).toISOString(), timeoutMs: 60_000 };
  assert.equal(effectiveStatus(job, Date.now(), alive), 'failed');
});

test('a cancelled job is not revived by a late worker update', () => {
  const directory = store();
  const job = writeJob(directory, { id: newJobId(), status: 'cancelled', createdAt: new Date().toISOString() });
  assert.equal(updateJob(directory, job.id, { status: 'completed' }).status, 'cancelled');
});

test('jobs list newest first and skip unreadable records', () => {
  const directory = store();
  writeJob(directory, { id: newJobId(1), status: 'completed', createdAt: '2026-11-11T01:00:00.000Z' });
  writeJob(directory, { id: newJobId(2), status: 'completed', createdAt: '2026-11-11T02:00:00.000Z' });
  const jobs = listJobs(directory);
  assert.deepEqual(jobs.map((job) => job.createdAt), ['2026-11-11T02:00:00.000Z', '2026-11-11T01:00:00.000Z']);
});
