import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { sameContent, staleFiles, stripImageRegions } from '../../scripts/build-directory-edition.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const edition = join(root, 'directory', 'agybird');

function files(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

test('the committed directory edition matches its sources', () => {
  assert.deepEqual(staleFiles(), []);
});

test('the directory edition carries no image capability', () => {
  for (const path of files(edition)) {
    if (path.endsWith('.svg') || path.endsWith('README.md')) continue;
    const text = readFileSync(path, 'utf8');
    assert.doesNotMatch(text, /generate_image|image-generator|--reference|agybird:image|category image/i, `${path} still mentions image work`);
  }
});

test('the edition runner refuses the image category and its companion has no image command', async () => {
  const runner = await import(pathToFileURL(join(edition, 'scripts', 'agybird.mjs')).href);
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-edition-'));
  assert.throws(() => runner.validateRequest({ category: 'image', mode: 'write', cwd, grants: [], grantScope: 'once', timeout: '1m' }), /Invalid category/);
  assert.throws(() => runner.parseArgs(['--category', 'code', '--cwd', cwd, '--reference', '/x.png']), /Unknown option: --reference/);
  const companion = await import(pathToFileURL(join(edition, 'scripts', 'companion.mjs')).href);
  assert.equal('image' in companion.COMMANDS, false);
  assert.equal('hook' in companion.COMMANDS, false, 'the edition has no Stop hook to serve');
  const full = await import(pathToFileURL(join(root, 'scripts', 'companion.mjs')).href);
  assert.equal('hook' in full.COMMANDS, true);
});

test('the edition manifest follows the package version and names the agent', () => {
  const manifest = JSON.parse(readFileSync(join(edition, '.claude-plugin', 'plugin.json'), 'utf8'));
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  assert.equal(manifest.version, version);
  assert.deepEqual(manifest.agents, ['./claude-agents/agybird-rescue.md']);
  assert.ok(manifest.description.length >= 120 && manifest.description.length <= 160);
});

test('image regions must be balanced', () => {
  assert.throws(() => stripImageRegions('// agybird:image-start\nx\n'), /left open/);
  assert.throws(() => stripImageRegions('x\n// agybird:image-end\n'), /without a start/);
  assert.equal(stripImageRegions('a\n  // agybird:image-start\nb\n  // agybird:image-end\nc'), 'a\nc');
});

test('line endings do not make an unchanged file read as stale', () => {
  assert.equal(sameContent('a\r\nb\r\n', 'a\nb\n'), true);
  assert.equal(sameContent('a\nb\n', 'a\nc\n'), false);
});

test('the directory edition ships no hook, no gate and no URL in its scripts', () => {
  for (const path of files(edition)) {
    const name = path.slice(edition.length + 1).split('\\').join('/');
    assert.doesNotMatch(name, /^hooks\/|^prompts\/stop-gate\.md$/, `${name} belongs to the review gate`);
    if (name.startsWith('scripts/')) assert.doesNotMatch(readFileSync(path, 'utf8'), /https?:\/\//, `${name} names a URL`);
    if (name.startsWith('commands/') || name === 'README.md') assert.doesNotMatch(readFileSync(path, 'utf8'), /review gate|--enable-review-gate/i, `${name} offers the gate`);
  }
});
