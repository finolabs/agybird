import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { acquireGrantLock, liveGrantLock, markProviderPending, otherLiveRuns, registerRun, runAgy } from '../../scripts/agybird.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dead = () => false;

test('a run whose provider may be starting stays live until its deadline, even with its runner gone', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agybird-admission-'));
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-admission-ws-'));
  const pending = registerRun(cwd, 'conv-b', directory, Date.now() + 60_000);
  markProviderPending(pending);
  assert.equal(otherLiveRuns(cwd, 'conv-a', null, directory, dead).length, 1, 'an unrecorded provider must keep the grant out');
  const expired = registerRun(cwd, 'conv-c', directory, Date.now() - 1);
  markProviderPending(expired);
  assert.equal(otherLiveRuns(cwd, 'conv-a', null, directory, dead).length, 1, 'only the expired pending record is discarded');
});

test('a dead runner that never started a provider is discarded at once', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agybird-admission-'));
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-admission-ws-'));
  registerRun(cwd, 'conv-b', directory, Date.now() + 60_000);
  assert.equal(otherLiveRuns(cwd, 'conv-a', null, directory, dead).length, 0);
});

test('a failure to record the provider does not abandon the run', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'agybird-admission-bin-'));
  copyFileSync(join(root, 'tests', 'fixtures', 'fake-agy.mjs'), join(bin, 'agy'));
  chmodSync(join(bin, 'agy'), 0o755);
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-admission-ws-'));
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` };
  const execution = await runAgy({ cwd, mode: 'read', timeout: '10s' }, 'CASE_SUCCESS', env, {
    onProviderSpawn: () => {
      throw new Error('disk full');
    },
  });
  assert.equal(execution.exitCode, 0);
  assert.match(execution.stdout, /"response":"ok"/);
});

test('a record updated while its runner dies is judged by what it says last', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agybird-admission-'));
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-admission-ws-'));
  const path = registerRun(cwd, 'conv-b', directory, Date.now() + 60_000);
  let marked = false;
  // The runner writes its pending mark and dies between the reader's first read and its liveness check.
  const isRunning = () => {
    if (!marked) {
      marked = true;
      markProviderPending(path);
    }
    return false;
  };
  assert.equal(otherLiveRuns(cwd, 'conv-a', null, directory, isRunning).length, 1);
});

test('looking for a grant lock that is not there removes nothing', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agybird-lock-'));
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-lock-ws-'));
  assert.equal(liveGrantLock(cwd, directory, () => true), null);
  const path = acquireGrantLock(cwd, 'conv-a', directory, () => true);
  assert.ok(path);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).conversation, 'conv-a', 'the lock is published whole');
  assert.deepEqual(readdirSync(dirname(path)).filter((name) => name.endsWith('.tmp')), []);
});

test('a stale lock replaced by a live one while it is being cleared is kept', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agybird-lock-'));
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-lock-ws-'));
  const path = acquireGrantLock(cwd, 'conv-old', directory, () => true);
  writeFileSync(path, JSON.stringify({ pid: 111111, conversation: 'conv-old' }));
  // While the reader decides the old holder is dead, another run takes the lock.
  const isRunning = (pid) => {
    if (pid === 111111) {
      rmSync(path, { force: true });
      writeFileSync(path, JSON.stringify({ pid: process.pid, conversation: 'conv-new' }));
      return false;
    }
    return pid === process.pid;
  };
  liveGrantLock(cwd, directory, isRunning);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).conversation, 'conv-new', 'the new holder must keep its lock');
});
