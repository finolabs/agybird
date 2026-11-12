import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { codexEditionFiles, writeEdition } from '../../scripts/build-codex-edition.mjs';

const files = codexEditionFiles();
const text = (path) => files.get(path).toString('utf8');

test('the Codex edition ships no lifecycle hooks and no Claude-only parts', () => {
  for (const path of files.keys()) {
    assert.doesNotMatch(path, /^(hooks|commands|claude-agents|agents|\.claude-plugin|\.antigravity-plugin|directory|editions|tests|docs)\//, path);
  }
  assert.equal(files.has('prompts/stop-gate.md'), false);
  const manifest = JSON.parse(text('.codex-plugin/plugin.json'));
  assert.equal('hooks' in manifest, false);
});

test('the Codex edition keeps every skill and every file its skills and manifest name', () => {
  const skills = [...files.keys()].filter((path) => /^\.codex-skills\/[^/]+\/SKILL\.md$/.test(path));
  assert.equal(skills.length, 10);
  for (const skill of skills) {
    for (const [, path] of text(skill).matchAll(/<plugin-root>\/([A-Za-z0-9_./-]+)/g)) assert.ok(files.has(path), `${skill} names ${path}`);
  }
  const manifest = JSON.parse(text('.codex-plugin/plugin.json'));
  for (const key of ['composerIcon', 'composerIconDark', 'logo', 'logoDark']) assert.ok(files.has(manifest.interface[key].replace(/^\.\//, '')), key);
  assert.equal(manifest.requires_local_executor, true);
  assert.equal(manifest.version, JSON.parse(readFileSync('package.json', 'utf8')).version);
  assert.ok(manifest.interface.displayName.length <= 30 && manifest.interface.shortDescription.length <= 30);
});

test('the edition setup skill and companion offer no review gate', () => {
  assert.doesNotMatch(text('.codex-skills/agybird-setup/SKILL.md'), /gate|hook/i);
  const root = mkdtempSync(join(tmpdir(), 'agybird-codex-edition-'));
  writeEdition(root, files);
  const env = { ...process.env, AGYBIRD_JOBS_DIR: mkdtempSync(join(tmpdir(), 'agybird-ce-jobs-')), PATH: mkdtempSync(join(tmpdir(), 'agybird-ce-path-')) };
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-ce-ws-'));
  const enable = spawnSync(process.execPath, [join(root, 'scripts', 'companion.mjs'), 'setup', '--enable-review-gate', '--json'], { cwd, env, encoding: 'utf8' });
  assert.notEqual(enable.status, 0);
  assert.match(enable.stderr, /no review gate/i);
  const plain = spawnSync(process.execPath, [join(root, 'scripts', 'companion.mjs'), 'setup', '--json'], { cwd, env, encoding: 'utf8' });
  assert.equal(JSON.parse(plain.stdout).reviewGateAvailable, false);
});
