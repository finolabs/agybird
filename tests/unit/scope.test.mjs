import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { collectScope } from '../../scripts/lib/scope.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repository() {
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-scope-'));
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'Test');
  writeFileSync(join(cwd, 'a.txt'), 'one\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', 'base');
  return cwd;
}

test('auto picks the working tree when it has changes, untracked files included', () => {
  const cwd = repository();
  writeFileSync(join(cwd, 'a.txt'), 'one\ntwo\n');
  writeFileSync(join(cwd, 'new.txt'), 'fresh\n');
  const scope = collectScope({ cwd, scope: 'auto' });
  assert.equal(scope.kind, 'working-tree');
  assert.match(scope.diff, /\+two/);
  assert.match(scope.diff, /new\.txt/);
  assert.match(scope.diff, /fresh/);
  assert.deepEqual(scope.files.sort(), ['a.txt', 'new.txt']);
});

test('auto falls back to the branch diff against its base when the tree is clean', () => {
  const cwd = repository();
  git(cwd, 'switch', '-q', '-c', 'feature');
  writeFileSync(join(cwd, 'b.txt'), 'branch work\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', 'feature');
  const scope = collectScope({ cwd, scope: 'auto' });
  assert.equal(scope.kind, 'branch');
  assert.equal(scope.base, 'main');
  assert.match(scope.diff, /branch work/);
});

test('an explicit base reviews the branch even with local changes', () => {
  const cwd = repository();
  git(cwd, 'switch', '-q', '-c', 'feature');
  writeFileSync(join(cwd, 'b.txt'), 'committed\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', 'feature');
  writeFileSync(join(cwd, 'c.txt'), 'local only\n');
  const scope = collectScope({ cwd, scope: 'branch', base: 'main' });
  assert.match(scope.diff, /committed/);
  assert.doesNotMatch(scope.diff, /local only/);
});

test('a clean tree on the base branch has nothing to review', () => {
  const scope = collectScope({ cwd: repository(), scope: 'auto' });
  assert.equal(scope.diff, '');
});

test('a diff over the limit is cut and says so', () => {
  const cwd = repository();
  writeFileSync(join(cwd, 'big.txt'), 'x'.repeat(5_000));
  const scope = collectScope({ cwd, scope: 'working-tree', maxBytes: 1_000 });
  assert.equal(scope.truncated, true);
  assert.ok(Buffer.byteLength(scope.diff) <= 1_200);
});

test('a base that looks like an option is refused', () => {
  assert.throws(() => collectScope({ cwd: repository(), scope: 'branch', base: '--output=/tmp/x' }), /Invalid base/);
});

test('outside a git repository the scope is refused', () => {
  assert.throws(() => collectScope({ cwd: mkdtempSync(join(tmpdir(), 'agybird-nogit-')), scope: 'auto' }), /git repository/);
});
