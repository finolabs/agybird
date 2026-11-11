// Collects the diff a review covers. agy cannot run git in a headless run
// without a grant, so the companion reads git itself and hands the text over.
// Git must not run anything the repository configures (fsmonitor, textconv,
// external diff), and nothing outside the work tree may be read.

import { spawnSync } from 'node:child_process';
import { closeSync, constants, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_MAX_BYTES = 400 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 64 * 1024;
const MAX_LISTED_FILES = 500;
// A ref name, never an option or a range: git would read "--x" as a flag.
const SAFE_REF = /^(?!-)[A-Za-z0-9._\/@{}^~-]+$/;
// Settings that would make git start a configured program.
const SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.quotepath=off', '-c', 'diff.external='];
const DIFF_OPTIONS = ['--no-color', '--no-ext-diff', '--no-textconv'];

// Content filters (clean, smudge, process) run the command a driver names when
// git reads the working tree. Every driver configured anywhere is blanked for
// the collection, so reviewing a change can never execute code from it.
// Turns the driver listing into overrides. Anything but a clean answer (exit 0,
// or 1 for no filters at all) refuses the review: a partial list would leave
// some driver able to run.
export function filterOverridesFrom(result) {
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    throw new Error('Could not read the git filter configuration completely, so the review was not started.');
  }
  const drivers = new Set();
  for (const key of (result.stdout ?? '').split('\0')) {
    const match = /^filter\.(.+)\.[^.]+$/.exec(key);
    if (match) drivers.add(match[1]);
  }
  return [...drivers].flatMap((name) => [
    '-c', `filter.${name}.clean=`,
    '-c', `filter.${name}.smudge=`,
    '-c', `filter.${name}.process=`,
    '-c', `filter.${name}.required=false`,
  ]);
}

function filterOverrides(cwd) {
  return filterOverridesFrom(spawnSync('git', [...SAFE_CONFIG, 'config', '--null', '--name-only', '--get-regexp', '^filter\\.'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  }));
}

// Git 2.41+ can read attributes from a tree instead of the work tree. Pointing it
// at the empty tree means no .gitattributes of the repository selects a driver.
export function supportsAttrSource(versionText) {
  const version = /(\d+)\.(\d+)/.exec(versionText ?? '');
  if (!version) return false;
  const [major, minor] = [Number(version[1]), Number(version[2])];
  return major > 2 || (major === 2 && minor >= 41);
}

function attributeSource(top) {
  return supportsAttrSource(gitText(top, ['--version'])) ? [`--attr-source=${emptyTree(top)}`] : [];
}

let overrides = null;
let attrSource = null;

function git(cwd, args, { allowFailure = false, maxBuffer = 16 * 1024 * 1024, input } = {}) {
  const result = spawnSync('git', [...(attrSource ?? []), ...SAFE_CONFIG, ...(overrides ?? []), ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer,
    input,
    shell: false,
    windowsHide: true,
  });
  // A diff larger than the buffer still returns what was read; the caller cuts it.
  if (result.error?.code === 'ENOBUFS') return { stdout: result.stdout ?? '', overflowed: true };
  if (result.status !== 0) {
    if (allowFailure) return null;
    throw new Error(`git ${args[0]} failed: ${String(result.stderr ?? result.error?.message ?? '').trim().slice(0, 300)}`);
  }
  return { stdout: result.stdout, overflowed: false };
}

function gitText(cwd, args, options) {
  return git(cwd, args, options)?.stdout ?? null;
}

function refExists(cwd, ref) {
  return gitText(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFailure: true }) !== null;
}

export function defaultBase(cwd) {
  const remoteHead = gitText(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFailure: true })?.trim();
  if (remoteHead && refExists(cwd, remoteHead)) return remoteHead;
  for (const candidate of ['main', 'master', 'origin/main', 'origin/master']) {
    if (refExists(cwd, candidate)) return candidate;
  }
  return null;
}

function nameList(output) {
  return (output ?? '').split('\0').filter(Boolean);
}

// Collects text until the budget is spent, so a huge change never sits in memory whole.
class Budget {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.parts = [];
    this.used = 0;
    // Bytes read from disk, shown or not; binary files count too.
    this.read = 0;
    this.readLimit = 4 * maxBytes;
    this.truncated = false;
  }

  get left() {
    return this.maxBytes - this.used;
  }

  add(text) {
    if (this.truncated || !text) return !this.truncated;
    const size = Buffer.byteLength(text);
    if (size <= this.left) {
      this.parts.push(text);
      this.used += size;
      return true;
    }
    this.parts.push(Buffer.from(text).subarray(0, Math.max(0, this.left)).toString('utf8'));
    this.used = this.maxBytes;
    this.truncated = true;
    return false;
  }

  text() {
    const body = this.parts.join('\n');
    return this.truncated ? `${body}\n[diff cut at ${this.maxBytes} bytes; read the listed files for the rest]` : body;
  }
}

// Reads at most `limit` bytes of a regular file without following a symlink.
function readRegularFile(path, limit) {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const buffer = Buffer.alloc(limit);
    const bytes = readSync(descriptor, buffer, 0, limit, 0);
    return buffer.subarray(0, bytes);
  } finally {
    closeSync(descriptor);
  }
}

function addUntracked(budget, top, files) {
  for (const file of files) {
    if (budget.truncated) return;
    if (budget.read >= budget.readLimit) {
      budget.add('[stopped reading new files at the read limit]');
      budget.truncated = true;
      return;
    }
    let stat;
    try {
      stat = lstatSync(join(top, file));
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      budget.add(`--- new symlink ${file} (not followed)`);
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_UNTRACKED_FILE_BYTES) {
      budget.add(`--- new file ${file} (${stat.size} bytes, not shown)`);
      continue;
    }
    let content;
    try {
      content = readRegularFile(join(top, file), Math.min(stat.size, budget.left + 1, budget.readLimit - budget.read));
      budget.read += content.length;

    } catch {
      continue;
    }
    if (content.includes(0)) {
      budget.add(`--- new file ${file} (binary, not shown)`);
      continue;
    }
    budget.add(`--- new file ${file}\n${content.toString('utf8').split('\n').map((line) => `+${line}`).join('\n')}`);
    // The read limit cut this file short: say so even if it is the last one.
    if (content.length < stat.size) budget.truncated = true;
  }
}

function listed(files) {
  return files.length > MAX_LISTED_FILES ? [...files.slice(0, MAX_LISTED_FILES), `(${files.length - MAX_LISTED_FILES} more files not listed)`] : files;
}

function emptyTree(top) {
  return gitText(top, ['hash-object', '-t', 'tree', '--stdin'], { input: '' }).trim();
}

export function collectScope({ cwd, scope = 'auto', base, maxBytes = DEFAULT_MAX_BYTES }) {
  if (!['auto', 'working-tree', 'branch'].includes(scope)) throw new Error(`Invalid scope: ${scope}; use auto, working-tree or branch`);
  if (base !== undefined && !SAFE_REF.test(base)) throw new Error(`Invalid base: ${base}`);
  if (gitText(cwd, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true })?.trim() !== 'true') {
    throw new Error('Review needs a git repository; run it inside one.');
  }
  const top = gitText(cwd, ['rev-parse', '--show-toplevel']).trim();
  overrides = null;
  attrSource = null;
  overrides = filterOverrides(top);
  attrSource = attributeSource(top);
  // Without a commit, compare the files on disk with the empty tree.
  const against = refExists(top, 'HEAD') ? 'HEAD' : emptyTree(top);
  const bufferFor = maxBytes + 1024 * 1024;

  const trackedChanges = nameList(gitText(top, ['diff', against, '--name-only', '-z', '--no-ext-diff', '--no-textconv']));
  const untracked = nameList(gitText(top, ['ls-files', '--others', '--exclude-standard', '-z']));
  const dirty = trackedChanges.length + untracked.length > 0;

  let kind = scope;
  if (scope === 'auto') kind = base === undefined && dirty ? 'working-tree' : 'branch';

  const budget = new Budget(maxBytes);
  if (kind === 'working-tree') {
    const tracked = git(top, ['diff', ...DIFF_OPTIONS, against], { maxBuffer: bufferFor });
    budget.add(tracked.stdout);
    if (tracked.overflowed) budget.truncated = true;
    addUntracked(budget, top, untracked);
    const diff = budget.text();
    return { kind, base: null, files: listed([...trackedChanges, ...untracked]), diff: diff.trim() ? diff : '', truncated: budget.truncated, bytesRead: budget.read, root: top };
  }

  const baseRef = base ?? defaultBase(top);
  if (!baseRef) throw new Error('No base branch found; pass --base <ref>.');
  if (!refExists(top, baseRef)) throw new Error(`Base ${baseRef} does not exist here.`);
  const mergeBase = gitText(top, ['merge-base', baseRef, 'HEAD']).trim();
  const files = nameList(gitText(top, ['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', mergeBase, 'HEAD']));
  const branchDiff = git(top, ['diff', ...DIFF_OPTIONS, mergeBase, 'HEAD'], { maxBuffer: bufferFor });
  budget.add(branchDiff.stdout);
  if (branchDiff.overflowed) budget.truncated = true;
  const diff = budget.text();
  return { kind: 'branch', base: baseRef, files: listed(files), diff: diff.trim() ? diff : '', truncated: budget.truncated, root: top };
}
