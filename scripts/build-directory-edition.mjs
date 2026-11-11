#!/usr/bin/env node
// Builds directory/agybird/, the edition submitted to Anthropic's plugin
// directory. The directory policy excludes AI image generation, so this edition
// is the full plugin with every image-only region removed. Sources stay at the
// repository root; never edit the generated folder by hand.
//
//   node scripts/build-directory-edition.mjs          rebuild the folder
//   node scripts/build-directory-edition.mjs --check  fail when it is out of date

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'directory', 'agybird');
const EDITION = join(ROOT, 'editions', 'directory');

const CODE_FILES = [
  'scripts/agybird.mjs',
  'scripts/companion.mjs',
  'scripts/lib/jobs.mjs',
  'scripts/lib/quota.mjs',
  'scripts/lib/render.mjs',
  'scripts/lib/scope.mjs',
];
const COPIED_FILES = [
  'prompts/review.md',
  'prompts/adversarial-review.md',
  'prompts/stop-gate.md',
  'schemas/review-output.schema.json',
  'commands/review.md',
  'commands/adversarial-review.md',
  'commands/rescue.md',
  'commands/status.md',
  'commands/result.md',
  'commands/cancel.md',
  'commands/setup.md',
  'commands/usage.md',
  'claude-agents/agybird-rescue.md',
  'hooks/hooks.json',
  'references/code.md',
  'references/docs.md',
  'LICENSE',
  'assets/icon.svg',
];
// Sentences in shared references that describe image work, removed exactly;
// a build fails when a source no longer contains one, so the list stays honest.
const REFERENCE_EDITS = {
  'references/common.md': [['Optional runner flags are `--reference`, ', 'Optional runner flags are ']],
  'references/general.md': [['neither repository engineering nor image creation', 'not repository engineering']],
  'references/security.md': [[', redacts raw provider diagnostics, and verifies image artifacts before reporting success.', ', and redacts raw provider diagnostics.']],
  'references/models.md': [[' Image work is the exception: the `image-generator` subagent picks its own model, so do not pass `--model` to choose one.', '']],
  'references/troubleshooting.md': [[' For images, look for the `image-generator` entry in `subagents[]` (or a `generate_image` call on older `agy`) and verify the artifact inside the working directory or the matching `brain/<conversation_id>` directory of the run or its image subagent.', '']],
};
const START = /^\s*\/\/ agybird:image-start\s*$/;
const END = /^\s*\/\/ agybird:image-end\s*$/;

export function stripImageRegions(text, name = 'source') {
  const kept = [];
  let depth = 0;
  for (const line of text.split('\n')) {
    if (START.test(line)) {
      if (depth) throw new Error(`${name}: nested image region`);
      depth = 1;
      continue;
    }
    if (END.test(line)) {
      if (!depth) throw new Error(`${name}: image-end without a start`);
      depth = 0;
      continue;
    }
    if (!depth) kept.push(line);
  }
  if (depth) throw new Error(`${name}: image region left open`);
  return kept.join('\n');
}

function applyEdits(text, edits, name) {
  let result = text;
  for (const [from, to] of edits) {
    if (!result.includes(from)) throw new Error(`${name}: expected text not found: ${from.slice(0, 60)}`);
    result = result.replace(from, to);
  }
  return result;
}

export function editionFiles() {
  const files = new Map();
  const read = (path) => readFileSync(join(ROOT, path), 'utf8');
  for (const path of CODE_FILES) files.set(path, stripImageRegions(read(path), path));
  for (const path of COPIED_FILES) files.set(path, read(path));
  for (const [path, edits] of Object.entries(REFERENCE_EDITS)) files.set(path, applyEdits(read(path), edits, path));
  files.set('SKILL.md', readFileSync(join(EDITION, 'SKILL.md'), 'utf8'));
  files.set('README.md', readFileSync(join(EDITION, 'README.md'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(EDITION, 'plugin.json'), 'utf8'));
  manifest.version = JSON.parse(read('package.json')).version;
  files.set('.claude-plugin/plugin.json', `${JSON.stringify(manifest, null, 2)}\n`);
  return files;
}

function write(directory, files) {
  rmSync(directory, { recursive: true, force: true });
  for (const [path, content] of files) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
}

function listFiles(directory, base = directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? listFiles(path, base) : [relative(base, path).split('\\').join('/')];
  });
}

// Differences between what the sources build and what is committed.
export function staleFiles() {
  const expected = editionFiles();
  const scratch = mkdtempSync(join(tmpdir(), 'agybird-edition-'));
  write(scratch, expected);
  let present = [];
  try {
    present = listFiles(OUTPUT);
  } catch {
    return [...expected.keys()];
  }
  const stale = [...expected.keys()].filter((path) => {
    try {
      return readFileSync(join(OUTPUT, path), 'utf8') !== expected.get(path);
    } catch {
      return true;
    }
  });
  stale.push(...present.filter((path) => !expected.has(path)));
  rmSync(scratch, { recursive: true, force: true });
  return stale;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--check')) {
    const stale = staleFiles();
    if (stale.length) {
      process.stderr.write(`directory/agybird is out of date; run node scripts/build-directory-edition.mjs. Differs: ${stale.join(', ')}\n`);
      process.exit(1);
    }
    process.stdout.write('directory/agybird is up to date.\n');
  } else {
    write(OUTPUT, editionFiles());
    process.stdout.write(`Built ${relative(ROOT, OUTPUT)}.\n`);
  }
}
