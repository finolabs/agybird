#!/usr/bin/env node
// Builds the ZIP submitted to OpenAI's Codex plugin directory. That directory
// rejects plugins with lifecycle hooks, and Codex finds hooks/hooks.json on its
// own, so this edition is the Codex plugin without hooks/ and without the review
// gate that the Stop hook runs. Nothing generated here is committed.
//
//   node scripts/build-codex-edition.mjs   writes dist/agybird-codex-<version>.zip

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EDITION = join(ROOT, 'editions', 'codex');

const FILES = [
  '.codex-plugin/plugin.json',
  'SKILL.md',
  'LICENSE',
  'scripts/agybird.mjs',
  'scripts/companion.mjs',
  'scripts/lib/jobs.mjs',
  'scripts/lib/quota.mjs',
  'scripts/lib/render.mjs',
  'scripts/lib/scope.mjs',
  'prompts/review.md',
  'prompts/adversarial-review.md',
  'schemas/review-output.schema.json',
  'assets/icon.svg',
  'assets/icon-dark.svg',
];
const FOLDERS = ['.codex-skills', 'references'];
// Edition files that replace a source file at the same path.
const OVERRIDES = ['.codex-skills/agybird-setup/SKILL.md'];

function listFiles(directory) {
  return readdirSync(join(ROOT, directory)).flatMap((name) => {
    const path = `${directory}/${name}`;
    return statSync(join(ROOT, path)).isDirectory() ? listFiles(path) : [path];
  });
}

export function codexEditionFiles() {
  const files = new Map();
  for (const path of [...FILES, ...FOLDERS.flatMap(listFiles)]) files.set(path, readFileSync(join(ROOT, path)));
  for (const path of OVERRIDES) files.set(path, readFileSync(join(EDITION, relative('.codex-skills', path))));
  const manifest = JSON.parse(files.get('.codex-plugin/plugin.json'));
  if (manifest.version !== JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version) throw new Error('.codex-plugin/plugin.json version differs from package.json');
  return files;
}

export function writeEdition(directory, files) {
  rmSync(directory, { recursive: true, force: true });
  for (const [path, content] of files) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = codexEditionFiles();
  const version = JSON.parse(files.get('.codex-plugin/plugin.json')).version;
  const staging = join(ROOT, 'dist', 'codex', 'agybird');
  const archive = join(ROOT, 'dist', `agybird-codex-${version}.zip`);
  writeEdition(staging, files);
  rmSync(archive, { force: true });
  const zip = spawnSync('zip', ['-X', '-q', '-r', archive, '.'], { cwd: staging, stdio: 'inherit' });
  if (zip.error || zip.status !== 0) {
    process.stderr.write(`zip failed${zip.error ? `: ${zip.error.message}` : ''}; the unpacked edition is in ${relative(ROOT, staging)}.\n`);
    process.exit(1);
  }
  process.stdout.write(`Built ${relative(ROOT, archive)} (${files.size} files).\n`);
}
