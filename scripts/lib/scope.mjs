// Collects the diff a review covers. agy cannot run git in a headless run
// without a grant, so the companion reads git itself and hands the text over.

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_MAX_BYTES = 400 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 64 * 1024;
// A ref name, never an option or a range: git would read "--x" as a flag.
const SAFE_REF = /^(?!-)[A-Za-z0-9._\/@{}^~-]+$/;

function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0 && !allowFailure) throw new Error(`git ${args[0]} failed: ${result.stderr.trim().slice(0, 300)}`);
  return result.status === 0 ? result.stdout : null;
}

function refExists(cwd, ref) {
  return git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFailure: true }) !== null;
}

export function defaultBase(cwd) {
  const remoteHead = git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFailure: true })?.trim();
  if (remoteHead && refExists(cwd, remoteHead)) return remoteHead;
  for (const candidate of ['main', 'master', 'origin/main', 'origin/master']) {
    if (refExists(cwd, candidate)) return candidate;
  }
  return null;
}

function untrackedFiles(cwd) {
  return (git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']) ?? '').split('\0').filter(Boolean);
}

function untrackedSection(cwd, files) {
  const parts = [];
  for (const file of files) {
    let text;
    try {
      const size = statSync(join(cwd, file)).size;
      if (size > MAX_UNTRACKED_FILE_BYTES) {
        parts.push(`--- new file ${file} (${size} bytes, not shown)`);
        continue;
      }
      text = readFileSync(join(cwd, file));
    } catch {
      continue;
    }
    if (text.includes(0)) {
      parts.push(`--- new file ${file} (binary, not shown)`);
      continue;
    }
    parts.push(`--- new file ${file}\n${text.toString('utf8').split('\n').map((line) => `+${line}`).join('\n')}`);
  }
  return parts.join('\n');
}

function cut(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  const kept = Buffer.from(text).subarray(0, maxBytes).toString('utf8');
  return { text: `${kept}\n[diff cut at ${maxBytes} bytes; review the rest from the file list]`, truncated: true };
}

function nameList(output) {
  return (output ?? '').split('\0').filter(Boolean);
}

export function collectScope({ cwd, scope = 'auto', base, maxBytes = DEFAULT_MAX_BYTES }) {
  if (!['auto', 'working-tree', 'branch'].includes(scope)) throw new Error(`Invalid scope: ${scope}; use auto, working-tree or branch`);
  if (base !== undefined && !SAFE_REF.test(base)) throw new Error(`Invalid base: ${base}`);
  if (git(cwd, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true })?.trim() !== 'true') {
    throw new Error('Review needs a git repository; run it inside one.');
  }
  const top = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const hasHead = refExists(top, 'HEAD');

  const trackedChanges = hasHead
    ? nameList(git(top, ['diff', 'HEAD', '--name-only', '-z']))
    : nameList(git(top, ['diff', '--cached', '--name-only', '-z']));
  const untracked = untrackedFiles(top);
  const dirty = trackedChanges.length + untracked.length > 0;

  let kind = scope;
  if (scope === 'auto') kind = base === undefined && dirty ? 'working-tree' : 'branch';

  if (kind === 'working-tree') {
    const tracked = hasHead
      ? git(top, ['diff', 'HEAD', '--no-color', '--no-ext-diff'])
      : git(top, ['diff', '--cached', '--no-color', '--no-ext-diff']);
    const { text, truncated } = cut([tracked, untrackedSection(top, untracked)].filter(Boolean).join('\n'), maxBytes);
    return { kind, base: null, files: [...trackedChanges, ...untracked], diff: text.trim() ? text : '', truncated, root: top };
  }

  const baseRef = base ?? defaultBase(top);
  if (!baseRef) throw new Error('No base branch found; pass --base <ref>.');
  if (!refExists(top, baseRef)) throw new Error(`Base ${baseRef} does not exist here.`);
  const mergeBase = git(top, ['merge-base', baseRef, 'HEAD']).trim();
  const files = nameList(git(top, ['diff', '--name-only', '-z', mergeBase, 'HEAD']));
  const { text, truncated } = cut(git(top, ['diff', '--no-color', '--no-ext-diff', mergeBase, 'HEAD']), maxBytes);
  return { kind: 'branch', base: baseRef, files, diff: text.trim() ? text : '', truncated, root: top };
}
