import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { collectScope, filterOverridesFrom } from '../../scripts/lib/scope.mjs';

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

test('a repository without commits reviews the files as they are on disk', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-unborn-'));
  git(cwd, 'init', '-q');
  writeFileSync(join(cwd, 'a.txt'), 'staged\n');
  git(cwd, 'add', 'a.txt');
  writeFileSync(join(cwd, 'a.txt'), 'staged\nedited after add\n');
  const scope = collectScope({ cwd, scope: 'auto' });
  assert.match(scope.diff, /edited after add/);
});

test('untracked symlinks are listed but never followed', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, () => {
  const cwd = repository();
  const outside = join(mkdtempSync(join(tmpdir(), 'agybird-outside-')), 'secret.txt');
  writeFileSync(outside, 'PRIVATE-CONTENT\n');
  symlinkSync(outside, join(cwd, 'link.txt'));
  const scope = collectScope({ cwd, scope: 'working-tree' });
  assert.doesNotMatch(scope.diff, /PRIVATE-CONTENT/);
  assert.match(scope.diff, /link\.txt/);
});

test('collection stops at the byte budget instead of reading everything first', () => {
  const cwd = repository();
  for (let index = 0; index < 50; index += 1) writeFileSync(join(cwd, `f${index}.txt`), 'y'.repeat(2_000));
  const scope = collectScope({ cwd, scope: 'working-tree', maxBytes: 10_000 });
  assert.equal(scope.truncated, true);
  assert.ok(Buffer.byteLength(scope.diff) <= 10_200);
  assert.ok(scope.files.length <= 500);
});

test('git never runs a configured textconv or fsmonitor helper', { skip: process.platform === 'win32' && 'uses a POSIX shell helper' }, () => {
  const cwd = repository();
  const marker = join(cwd, '..', `ran-${Date.now()}`);
  writeFileSync(join(cwd, '.gitattributes'), '*.txt diff=evil\n');
  git(cwd, 'config', 'diff.evil.textconv', `sh -c "touch ${marker}; cat \\"$1\\"" -`);
  git(cwd, 'config', 'core.fsmonitor', `sh -c "touch ${marker}"`);
  writeFileSync(join(cwd, 'a.txt'), 'one\nchanged\n');
  collectScope({ cwd, scope: 'working-tree' });
  assert.equal(existsSync(marker), false, 'a repository helper ran during collection');
});

test('git never runs a configured clean or process filter', { skip: process.platform === 'win32' && 'uses a POSIX shell helper' }, () => {
  const cwd = repository();
  const marker = join(cwd, '..', `filter-ran-${Date.now()}`);
  writeFileSync(join(cwd, '.gitattributes'), '*.txt filter=normalize\n');
  git(cwd, 'config', 'filter.normalize.clean', `sh -c "touch ${marker}; cat"`);
  git(cwd, 'config', 'filter.normalize.process', `sh -c "touch ${marker}; exit 1"`);
  git(cwd, 'config', 'filter.normalize.required', 'true');
  writeFileSync(join(cwd, 'a.txt'), 'one\nfiltered change\n');
  const scope = collectScope({ cwd, scope: 'working-tree' });
  assert.equal(existsSync(marker), false, 'a configured filter ran during collection');
  assert.match(scope.diff, /filtered change/);
});

test('binary untracked files count against a read limit too', () => {
  const cwd = repository();
  for (let index = 0; index < 40; index += 1) writeFileSync(join(cwd, `b${index}.bin`), Buffer.alloc(2_000, 0));
  const scope = collectScope({ cwd, scope: 'working-tree', maxBytes: 4_000 });
  assert.equal(scope.truncated, true);
  assert.ok(scope.bytesRead <= 4 * 4_000 + 2_000, `read ${scope.bytesRead} bytes`);
});

test('a file cut short by the read limit marks the scope truncated', () => {
  const cwd = repository();
  for (let index = 0; index < 4; index += 1) writeFileSync(join(cwd, `a${index}.bin`), Buffer.alloc(3_500, 0));
  writeFileSync(join(cwd, 'z-last.txt'), 'q'.repeat(3_000));
  const scope = collectScope({ cwd, scope: 'working-tree', maxBytes: 4_000 });
  assert.equal(scope.truncated, true);
});

test('a failed filter listing refuses the review instead of running filters', () => {
  assert.throws(() => filterOverridesFrom({ error: Object.assign(new Error('x'), { code: 'ENOBUFS' }), stdout: 'filter.a' }), /filter configuration/);
  assert.throws(() => filterOverridesFrom({ status: null, signal: 'SIGKILL', stdout: '' }), /filter configuration/);
  assert.throws(() => filterOverridesFrom({ status: 128, stdout: '' }), /filter configuration/);
  assert.deepEqual(filterOverridesFrom({ status: 1, stdout: '' }), []);
  assert.ok(filterOverridesFrom({ status: 0, stdout: 'filter.lfs.clean\0filter.lfs.smudge\0' }).includes('filter.lfs.clean='));
});
