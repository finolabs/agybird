import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { acquireGrantLock, liveGrantLock, markProviderPending, otherLiveRuns, registerRun, releaseGrantLock, runAgy } from '../../scripts/agybird.mjs';

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

function lockFiles(directory) {
  const root = join(directory, 'grant-locks');
  try {
    return readdirSync(root, { recursive: true }).map(String).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

test('reading the grant lock never changes it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agybird-lock-'));
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-lock-ws-'));
  assert.equal(liveGrantLock(cwd, directory, () => true), null);
  const path = acquireGrantLock(cwd, 'conv-a', directory, () => true);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).conversation, 'conv-a', 'the lock is published whole');
  const before = lockFiles(directory);
  liveGrantLock(cwd, directory, () => false);
  liveGrantLock(cwd, directory, () => true);
  assert.deepEqual(lockFiles(directory), before, 'a reader removes nothing, live or dead');
});

test('a dead holder is superseded, not deleted, and only one run wins the next generation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agybird-lock-'));
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-lock-ws-'));
  const BEE = 222222;
  const stale = acquireGrantLock(cwd, 'conv-old', directory, () => true);
  writeFileSync(stale, JSON.stringify({ pid: 111111, conversation: 'conv-old' }));
  let bLock = null;
  // A sees the dead holder; while it decides, B takes the next generation.
  const isRunning = (pid) => {
    if (pid === 111111) {
      if (bLock === null) {
        bLock = acquireGrantLock(cwd, 'conv-b', directory, (other) => other === BEE);
        writeFileSync(bLock, JSON.stringify({ pid: BEE, conversation: 'conv-b' }));
      }
      return false;
    }
    return pid === BEE;
  };
  assert.equal(acquireGrantLock(cwd, 'conv-a', directory, isRunning), null, 'A must lose to B');
  assert.equal(liveGrantLock(cwd, directory, isRunning)?.pid, BEE, 'B holds the lock');
  assert.equal(acquireGrantLock(cwd, 'conv-c', directory, isRunning), null, 'C must not get it either');
  assert.equal(JSON.parse(readFileSync(bLock, 'utf8')).conversation, 'conv-b');
  releaseGrantLock(bLock);
  assert.equal(liveGrantLock(cwd, directory, isRunning), null, 'released means free');
});

test('a lock left in the previous single-file layout is still honoured', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agybird-lock-'));
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-lock-ws-'));
  const first = acquireGrantLock(cwd, 'conv-a', directory, () => true);
  const legacy = join(directory, 'grant-locks', `${first.split(/[\\/]/).at(-2)}.json`);
  releaseGrantLock(first);
  writeFileSync(legacy, JSON.stringify({ pid: process.pid, conversation: 'conv-legacy' }));
  assert.equal(liveGrantLock(cwd, directory, (pid) => pid === process.pid)?.conversation, 'conv-legacy');
  assert.equal(acquireGrantLock(cwd, 'conv-b', directory, (pid) => pid === process.pid), null);
});

test('a contender that wakes after the lock was released and taken again cannot take it too', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agybird-lock-'));
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-lock-ws-'));
  const stale = acquireGrantLock(cwd, 'conv-old', directory, () => true);
  writeFileSync(stale, JSON.stringify({ pid: 111111, conversation: 'conv-old' }));
  const CEE = 333333;
  let cLock = null;
  // A sees the dead holder of generation 0 and pauses; meanwhile B takes the
  // lock and releases it, and C takes it.
  const isRunning = (pid) => {
    if (pid === 111111 && cLock === null) {
      const bLock = acquireGrantLock(cwd, 'conv-b', directory, () => false);
      releaseGrantLock(bLock);
      cLock = acquireGrantLock(cwd, 'conv-c', directory, () => false);
      writeFileSync(cLock, JSON.stringify({ pid: CEE, conversation: 'conv-c' }));
      return false;
    }
    return pid === CEE;
  };
  assert.equal(acquireGrantLock(cwd, 'conv-a', directory, isRunning), null, 'A must not take a lock C holds');
  assert.equal(liveGrantLock(cwd, directory, isRunning)?.conversation, 'conv-c');
});

test('a contender whose generation was pruned meanwhile backs off', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agybird-lock-'));
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-lock-ws-'));
  const first = acquireGrantLock(cwd, 'conv-old', directory, () => true);
  writeFileSync(first, JSON.stringify({ pid: 111111, conversation: 'conv-old' }));
  const folder = dirname(first);
  const DEE = 444444;
  let raced = false;
  const isRunning = (pid) => {
    if (pid === 111111 && !raced) {
      raced = true;
      // Many grants later: a live holder at generation 40, older ones pruned.
      for (let n = 1; n < 40; n += 1) writeFileSync(join(folder, `${n}.json`), JSON.stringify({ released: true }));
      writeFileSync(join(folder, '40.json'), JSON.stringify({ pid: DEE, conversation: 'conv-d' }));
      for (let n = 0; n < 20; n += 1) rmSync(join(folder, `${n}.json`), { force: true });
      return false;
    }
    return pid === DEE;
  };
  assert.equal(acquireGrantLock(cwd, 'conv-a', directory, isRunning), null);
  assert.equal(liveGrantLock(cwd, directory, isRunning)?.conversation, 'conv-d');
  assert.equal(readdirSync(folder).includes('1.json'), false, 'A removed the generation it published below the lock');
});
