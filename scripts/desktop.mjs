#!/usr/bin/env node
// The desktop transport's runner: the same arguments, stdin prompt and one-line
// JSON envelope as agybird.mjs, but the task runs in a new conversation of the
// Antigravity desktop app, driven through macOS Accessibility (desktop-ax.js).
// Every run starts a new conversation; the app's permissions preset is used as
// the user set it and never changed.

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { buildDelegationPrompt, createProject, findProjectForWorkspace, isDirectExecution, parseArgs, readPrompt, timeoutToMilliseconds, validateRequest } from './agybird.mjs';
import { callBridge } from './lib/desktop-bridge.mjs';
import { Blocked, changedFiles, diffStat, checkLabels, checkPlatform, checkProbe, envelope, permissionRequest, presetWarnings, refusedOption, structuredFromReply } from './lib/desktop-state.mjs';
import { collectScope } from './lib/scope.mjs';

const BUNDLE_ID = 'com.google.antigravity';
const DEFAULT_POLL_MS = 2_500;
// A run's marker: the random hex its prompt ends with, as `[agybird-run <hex>]`
// (desktop-ax.js marker()). Its conversation is the one that shows it.
const RUN_MARKER = /^[0-9a-f]{16,64}$/;

class Cancelled extends Error {}

class TimedOut extends Error {
  constructor(timeout) {
    super(`The run timed out after ${timeout}.`);
  }
}

class OtherConversation extends Error {
  constructor(title, { late = false, unbound = false, unmarked = false } = {}) {
    let message = `The Antigravity app now shows another conversation (${JSON.stringify(title)}); the run stopped reading and pressed nothing there. Check the run's conversation in the app.`;
    if (late) message = `The Antigravity app showed a titled conversation (${JSON.stringify(title)}) only after Send had returned without one, so the run cannot tell it from another conversation; it stopped reading and pressed nothing. Check the run's conversation in the app.`;
    if (unbound) message = `After Send the Antigravity app showed a conversation (${JSON.stringify(title)}) the run could not tie to the one it sent: it did not show the run's own message, or it is in another project. The run read nothing there and pressed nothing. Check the run's conversation in the app.`;
    if (unmarked) message = `The Antigravity app shows a conversation titled ${JSON.stringify(title)} whose text does not include the run's own message, so the run cannot tell it is the run's own; it stopped reading and pressed nothing there. Check the run's conversation in the app.`;
    super(message);
  }
}

// Send waits in the app for the new conversation's title, which identifies it.
const SEND_TIMEOUT_MS = 45_000;
// The bridge calls of cleanup are bounded, so that all a signalled run may
// still make fit the 20 s the companion gives it before it kills the run. A
// run holding the app: a decline and Stop (5 s each), then the clipboard and
// the front app (3 s each), 16 s at most. A run waiting with the app free
// first takes it back (attach): the lock wait, the sidebar read, the row and
// the check all end within CANCEL_BUDGET_MS of the signal less Stop's 5 s, so
// Stop still ends within it. Clearing the composer replaces Stop: a probe,
// the switch and the clear (3 + 3 + 5 s), then the clipboard and the front
// app (3 + 3 s), 17 s at most; it starts only when that worst case still ends
// within CANCEL_BUDGET_MS of the signal, so a restore already under way when
// the signal came is counted. The lock and the run record already say the app
// may run before any of them (markLockForApp).
const PRESS_TIMEOUT_MS = 5_000;
const RESTORE_TIMEOUT_MS = 3_000;
// After a signal, the clearing path starts only when its worst case still ends
// this long after the signal, inside the companion's 20 s grace with a margin;
// a restore already under way when the signal came counts against it.
const CANCEL_BUDGET_MS = 18_000;
// The app comes to the front only once the user has left the keyboard and
// mouse alone this long, waiting at most IDLE_WAIT_MS for it.
const IDLE_SECONDS = 3;
const IDLE_WAIT_MS = 120_000;
const IDLE_POLL_MS = 500;
// After Send the run keeps the app this long, or until the app renames its
// conversation, reading it on screen; it then waits on its sidebar row with the
// app free for other runs, and takes the app back only to read the result.
const SETTLE_MS = 15_000;
// Desktop runs that may be between their start and their result at once (Fio, 28/11/2026).
const MAX_RUNS = 5;
// How long a starting run waits for a run acting in phases to give the app
// back. A run that already sent its task waits for the app until its own
// deadline instead (a run of 0.4.8 or earlier holds it for its whole turn);
// in a cancel's grace, attach() fits CANCEL_BUDGET_MS.
const ATTACH_WAIT_MS = 120_000;
// Reads of the window after a sidebar row is opened, and the wait between them.
const OPEN_READS = 4;
const OPEN_READ_GAP_MS = 500;

// The sidebar lists a conversation by its own name: the window title
// "<name> - <project> - Antigravity" without its last two parts.
function rowTitle(windowTitle, project) {
  const suffix = ` - ${project} - Antigravity`;
  return windowTitle.endsWith(suffix) ? windowTitle.slice(0, -suffix.length) : windowTitle;
}

// Run records: one file per run between its start and its result, named by
// its marker: { pid, marker, project, title, expiresAt, app }. `app` is set
// from Send on: the app may run the task whatever becomes of the run. Written
// whole (a temporary file renamed into place), so no reader sees a part.
function writeRecord(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

// Every readable record; another file there (a temporary one, .DS_Store) is not one.
function readRecords(directory) {
  let entries = [];
  try {
    entries = readdirSync(directory).filter((entry) => entry.endsWith('.json'));
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry);
    try {
      const record = JSON.parse(readFileSync(path, 'utf8'));
      return record && typeof record === 'object' ? [{ path, record }] : [];
    } catch {
      return [];
    }
  });
}

const recordAlive = (record) => Number.isInteger(record.pid) && record.pid > 0 && processIsRunning(record.pid);

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// A lock with no content yet is being written, so it counts as held this long.
const UNREADABLE_LOCK_MS = 60_000;
// Past its run's deadline plus this margin, a lock is stale even if its pid now
// belongs to another process.
const LOCK_MARGIN_MS = 5 * 60_000;

function readLock(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8').trim();
  } catch (error) {
    return error.code === 'ENOENT' ? null : { unreadable: true };
  }
  if (!text) return { unreadable: true };
  try {
    return text.startsWith('{') ? JSON.parse(text) : { pid: Number(text) };
  } catch {
    return { unreadable: true };
  }
}

const sameLock = (a, b) => Boolean(a && b) && a.pid === b.pid && a.conversation === b.conversation && a.marker === b.marker && a.expiresAt === b.expiresAt;

// `ended` is an app lock the app was seen to be done with: its conversation on
// screen with no run.
function lockHeld(path, holder, ended = null) {
  if (holder.unreadable) {
    try {
      return Date.now() - statSync(path).mtimeMs < UNREADABLE_LOCK_MS;
    } catch {
      return false;
    }
  }
  const alive = Number.isInteger(holder.pid) && holder.pid > 0 && processIsRunning(holder.pid);
  // Marked from Send on: the app may run the task whether or not its run is
  // still alive, and the app sets no deadline on it, so no expiry frees it.
  // Only evidence does: the app showing its conversation with no run, once its
  // run is gone, or the user removing the lock.
  if (holder.app === true) return alive || !sameLock(holder, ended);
  if (Number.isFinite(holder.expiresAt) && Date.now() > holder.expiresAt) return false;
  return alive;
}

// The lock of a run that is gone and left the app possibly running, with the
// conversation to check (its title and its run's marker), if it knew one.
function abandonedAppLock(path) {
  const holder = readLock(path);
  if (holder?.app !== true || !holder.conversation || !RUN_MARKER.test(holder.marker ?? '')) return null;
  return Number.isInteger(holder.pid) && holder.pid > 0 && processIsRunning(holder.pid) ? null : holder;
}

// A takeover guard older than this was left by a run that died while holding it.
const GUARD_STALE_MS = 30_000;

function takeGuard(guard) {
  try {
    closeSync(openSync(guard, 'wx', 0o600));
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      if (Date.now() - statSync(guard).mtimeMs > GUARD_STALE_MS) rmSync(guard, { force: true });
    } catch {
      // removed by its holder meanwhile
    }
    return false;
  }
}

// One desktop run acts on the app at a time: they share one app and one
// clipboard, and each holds this lock only while it acts (its start, then its
// result). The lock is linked into place whole, never seen empty. A free place
// is taken by the link alone; a stale lock is removed only by the run holding
// the takeover guard, after it reads the lock again under the guard. No run can
// then remove a lock another run has just taken, so at most one run holds it.
// `hooks.stale` runs once a run holds the guard over a stale lock (tests only).
// `ended` is an app lock the caller saw the app to be done with.
export function acquireLock(path, expiresAt, { pid = process.pid, hooks = {}, ended = null } = {}) {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  // `runs`: the holder is a run that acts in phases and gives the lock back
  // soon, so a run that finds it held waits for it instead of giving up.
  const content = JSON.stringify({ pid, expiresAt, runs: true });
  const temporary = `${path}.${pid}.tmp`;
  const guard = `${path}.takeover`;
  const link = () => {
    // A leftover, or a link planted at this name, is removed, never written through.
    rmSync(temporary, { force: true });
    writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    try {
      linkSync(temporary, path);
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return false;
    } finally {
      rmSync(temporary, { force: true });
    }
  };
  let holder = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (link()) return path;
    holder = readLock(path);
    if (holder === null) continue;
    if (lockHeld(path, holder, ended) || !takeGuard(guard)) break;
    try {
      hooks.stale?.();
      const again = readLock(path);
      if (again !== null && lockHeld(path, again, ended)) break;
      rmSync(path, { force: true });
      if (link()) return path;
    } finally {
      rmSync(guard, { force: true });
    }
  }
  if (holder?.app === true && !(Number.isInteger(holder.pid) && processIsRunning(holder.pid))) {
    const where = holder.conversation ? ` in its conversation ${JSON.stringify(holder.conversation)}; once the app shows that conversation with no run, or its sidebar lists it alone under Idle, retry` : '';
    throw new Blocked('locked', `An earlier desktop run may still be going in the Antigravity app${where}. Or, once you are sure the app runs nothing for it, remove ${path}.`);
  }
  throw new Blocked('locked', 'Another desktop run is using the Antigravity app; retry once it finishes.');
}

// From just before Send (or an answer) is pressed, the lock says the app may
// run this task, with its conversation once known, so it outlives this process
// however it ends, a kill during cleanup included. Released only by a run that
// saw the task end, by evidence (lockHeld), or by the user.
function markLockForApp(path, expiresAt, conversation, marker, project) {
  if (readLock(path)?.pid !== process.pid) return;
  const temporary = `${path}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, JSON.stringify({ pid: process.pid, expiresAt, runs: true, app: true, conversation, marker, project }), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

function releaseLock(path) {
  if (readLock(path)?.pid === process.pid) rmSync(path, { force: true });
}

// Every project name on this Mac, read from the project files.
function projectNames(directory) {
  let entries = [];
  try {
    entries = readdirSync(directory).filter((entry) => entry.endsWith('.json'));
  } catch {
    return [];
  }
  return entries.map((entry) => {
    try {
      return JSON.parse(readFileSync(join(directory, entry), 'utf8')).name;
    } catch {
      return undefined;
    }
  });
}

// The name a new project takes: the folder's name for a main checkout or a
// plain folder, `<repo>-<worktree>` for a linked worktree (the repo named by
// the main checkout that holds the common Git directory), then -2, -3... while
// a project already has it (Fio, 28/11/2026).
export function newProjectName(cwd, taken) {
  // The repository's own git programs stay off, as scope.mjs keeps them.
  const git = (args) => {
    const result = spawnSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], { cwd, encoding: 'utf8', shell: false, windowsHide: true, timeout: 10_000 });
    return result.status === 0 ? String(result.stdout ?? '').trim() : null;
  };
  const inside = git(['rev-parse', '--is-inside-work-tree']) === 'true';
  let base = basename(cwd) || 'workspace';
  if (inside) {
    const gitDir = git(['rev-parse', '--git-dir']);
    const common = git(['rev-parse', '--git-common-dir']);
    if (gitDir && common && resolve(cwd, gitDir) !== resolve(cwd, common)) {
      // A main checkout's common directory is <repo>/.git; a bare one is <repo>.git or <repo>.
      const commonDir = resolve(cwd, common);
      const repo = basename(commonDir) === '.git' ? basename(dirname(commonDir)) : basename(commonDir).replace(/\.git$/, '');
      if (repo) base = `${repo}-${basename(cwd)}`;
    }
  }
  const used = new Set(taken);
  let name = base;
  for (let n = 2; used.has(name); n += 1) name = `${base}-${n}`;
  return { name, git: inside };
}

// The app lists projects by name only, so the name must lead to this folder
// alone. A folder no project points at gets a new project (Fio, 28/11/2026),
// except for a resumed answer, whose project the asking run already used.
function resolveProject(cwd, directory, { create = true } = {}) {
  const found = findProjectForWorkspace(cwd, directory);
  if (!found && !create) throw new Blocked('no_project', `No Antigravity project points at ${cwd} any more, so the conversation that asked cannot be found; answer the prompt in the app.`);
  if (!found) {
    const { name, git } = newProjectName(cwd, projectNames(directory));
    createProject(cwd, name, { directory, git });
    return { name, created: true };
  }
  const name = found.document?.name;
  if (!name) throw new Blocked('no_project', `The Antigravity project for ${cwd} has no name; name it in the app.`);
  const namesakes = projectNames(directory).filter((other) => other === name);
  if (namesakes.length > 1) throw new Blocked('ambiguous_project', `${namesakes.length} Antigravity projects are named ${JSON.stringify(name)}; rename all but the one for ${cwd} in the app.`);
  return { name, created: false };
}

function fileHash(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return 'missing';
  }
}

// The working tree as file hashes, read with the repository's git programs off,
// over every changed or untracked file, not only the first ones a review lists.
// Outside a repository there is nothing to compare.
function workTree(cwd) {
  let scope;
  try {
    scope = collectScope({ cwd, scope: 'working-tree', maxBytes: 1, listLimit: Infinity });
  } catch {
    return null;
  }
  const head = spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: scope.root, encoding: 'utf8', shell: false, windowsHide: true }).stdout?.trim() ?? '';
  return { head, hashes: Object.fromEntries(scope.files.map((file) => [file, fileHash(join(scope.root, file))])) };
}

// `--resume-dialog <question> --resume-title <conversation title>
// --resume-marker <run marker>` belong to this runner only: after the user's
// yes, it answers the prompt the app is waiting on in that conversation, which
// must still show the asking run's own message, instead of sending a task.
// `--resume-ack <file>` is created before the answer's step starts, so the approval is spent however the
// run ends from then on, a kill during the step included; only a refusal the
// bridge reports before any press removes it again.
function takeResume(argv) {
  let rest = argv;
  const take = (flag) => {
    const index = rest.indexOf(flag);
    if (index < 0) return null;
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    rest = [...rest.slice(0, index), ...rest.slice(index + 2)];
    return value;
  };
  const question = take('--resume-dialog');
  const title = take('--resume-title');
  const marker = take('--resume-marker');
  const answer = take('--resume-answer') ?? '1';
  const ack = take('--resume-ack');
  if ((question === null) !== (title === null) || (question === null) !== (marker === null)) throw new Error('--resume-dialog, --resume-title and --resume-marker go together');
  if (marker !== null && !RUN_MARKER.test(marker)) throw new Error('--resume-marker is the run marker the asking run recorded');
  if (ack !== null && question === null) throw new Error('--resume-ack goes with --resume-dialog');
  if (!['1', 'Skip'].includes(answer)) throw new Error('--resume-answer is 1 or Skip');
  return { argv: rest, question, title, marker, answer, ack };
}

// A new conversation's web area reads "Antigravity" until the app titles it.
const UNTITLED = 'Antigravity';
// A titled conversation of `project`: "<title> - <project> - Antigravity".
const isProjectTitle = (title, project) => String(title).length > ` - ${project} - ${UNTITLED}`.length && String(title).endsWith(` - ${project} - ${UNTITLED}`);
// A snapshot marked `truncated` was read from a tree cut off at desktop-ax.js
// MAX_NODES: it shows no conversation, and nothing is decided on it.
const PARTIAL_TREE = "The Antigravity app's accessibility tree is too large to read whole (past 20,000 nodes)";

// Links in the composer are separate nodes, so whitespace around them differs;
// every other character must read back in order.
const normalized = (text) => String(text ?? '').replace(/\s+/g, '');

// `--archive-finished`: archives the conversations of runs that already ended,
// listed on stdin as JSON [{ title, project }] (the app's window titles), each
// only when its sidebar row is alone and Idle. Holds the app lock meanwhile,
// waiting for a run that acts in phases as a starting run does; it never
// brings the app to the front or changes the conversation on screen.
export async function archiveFinished(items, env = process.env) {
  const platform = env.AGYBIRD_DESKTOP_BRIDGE ? 'darwin' : process.platform;
  checkPlatform(platform);
  const call = (args, options) => callBridge(args, { env, ...options });
  const probe = await call(['probe']);
  checkProbe(probe, { platform, allowVersion: env.AGYBIRD_DESKTOP_ALLOW_VERSION === '1' });
  const lockFile = join(env.AGYBIRD_STATE_DIR || join(homedir(), '.agybird'), 'desktop.lock');
  const until = Date.now() + ATTACH_WAIT_MS;
  let lockPath = null;
  for (;;) {
    try {
      lockPath = acquireLock(lockFile, Date.now() + 10 * 60_000);
      break;
    } catch (error) {
      const holder = readLock(lockFile);
      const phased = holder === null || (holder.runs === true && Number.isInteger(holder.pid) && holder.pid > 0 && processIsRunning(holder.pid));
      if (!(error instanceof Blocked) || Date.now() >= until || !phased) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const archived = [];
  const skipped = [];
  // A run of 0.4.8 or earlier recorded no project: the longest project name
  // the title ends with is its project.
  const names = projectNames(env.AGYBIRD_PROJECTS_DIR || join(homedir(), '.gemini', 'config', 'projects'));
  const projectOf = (title) => names.filter((name) => typeof name === 'string' && name && String(title).endsWith(` - ${name} - Antigravity`)).sort((a, b) => b.length - a.length)[0] ?? null;
  try {
    for (const item of items) {
      const title = item?.title;
      const project = typeof item?.project === 'string' ? item.project : projectOf(title);
      if (typeof title !== 'string' || typeof project !== 'string' || !isProjectTitle(title, project)) {
        skipped.push({ title, reason: 'no conversation title of its project' });
        continue;
      }
      try {
        await call(['archive-row', rowTitle(title, project), project], { timeoutMs: PRESS_TIMEOUT_MS });
        archived.push(title);
      } catch (error) {
        skipped.push({ title, reason: error.message.replace(/^.* failed: /, '') });
      }
    }
  } finally {
    if (lockPath) releaseLock(lockPath);
  }
  return { archived, skipped };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--archive-finished')) {
    try {
      const items = JSON.parse((await readPrompt()) || '[]');
      if (!Array.isArray(items)) throw new Error('--archive-finished reads a JSON list of { title, project } on stdin');
      process.stdout.write(`${JSON.stringify({ status: 'success', ...(await archiveFinished(items, env)) })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ status: error instanceof Blocked ? 'blocked' : 'error', blocked_reason: error.reason, error: error.message })}\n`);
      process.exitCode = error instanceof Blocked ? 0 : 1;
    }
    return;
  }
  // A signal marks the run cancelled and interrupts the step in flight; the run
  // then cleans up itself, so cleanup never races a bridge call still running.
  let cancelled = false;
  // When the signal came: the cleanup that follows a cancel fits CANCEL_BUDGET_MS from it.
  let cancelledAt = null;
  let wake = () => {};
  // A signal interrupts the step in flight (a long paste included), so cleanup
  // runs at once instead of after it; cleanup's own calls are never interrupted.
  const interrupt = new AbortController();
  const call = (args, options) => callBridge(args, { env, ...options });
  const bridge = async (args, options) => {
    if (cancelled) throw new Cancelled();
    let value;
    try {
      value = await call(args, { ...options, signal: interrupt.signal });
    } catch (error) {
      if (cancelled) throw new Cancelled();
      throw error;
    }
    if (cancelled) throw new Cancelled();
    return value;
  };
  const sleep = (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  const evidence = { app_version: null, preset: null, session_resumed: false, changed_files: [] };
  const warnings = [];
  let options;
  let lockPath = null;
  let saved = null;
  let pasted = false;
  // Set once Send (or, resumed, the answer) may have been pressed, so the app may be running the task.
  let sent = false;
  // A resumed run about to press its answer.
  let answering = false;
  // Set once the turn ended or the app waits on a prompt: nothing runs any more.
  let turnOver = false;
  // Set when the app may still run the task but Stop could not be pressed.
  let holdLock = false;
  // Set once the run waits on its sidebar row with the app lock released.
  let detached = false;
  let lockFile = null;
  let runRecord = null;
  // Set when the run ends with the app maybe still running its task, Stop not
  // pressed and the lock not held: its record stays to say so (B4).
  let keepRecord = false;
  let projectName = null;
  let lockExpiresAt = null;
  // The turn's deadline, once the task was sent.
  let runDeadline = Infinity;
  let finished = false;
  // The title of the run's own conversation, as the Send call read it right
  // after pressing Send; null while it is the untitled new conversation.
  let conversation = null;
  // The run's marker: its prompt's last line carries it, so the conversation
  // that shows it is the run's own. Every read after Send and every press
  // checks it in the same read as the title. A resumed run takes the asking
  // run's marker.
  let marker = randomBytes(8).toString('hex');
  const expected = () => conversation ?? UNTITLED;
  // `app`: from just before Send (or the answer) on, as the lock (markLockForApp).
  const writeOwnRecord = (app) => {
    if (runRecord) writeRecord(runRecord, { pid: process.pid, marker, project: projectName, title: conversation, expiresAt: lockExpiresAt, app });
  };
  const markApp = () => {
    if (lockPath) markLockForApp(lockPath, lockExpiresAt, conversation, marker, projectName);
    writeOwnRecord(true);
  };
  // Gives the app to other runs while the agent works.
  const detach = () => {
    if (!lockPath || holdLock) return;
    releaseLock(lockPath);
    lockPath = null;
    detached = true;
  };
  // Opens the run's conversation from its sidebar row, checked by title and the
  // run's own marker in the same read; a namesake row is skipped. False when
  // the sidebar lists no row of it. `limit(ms)` gives each call's options.
  const openOwnRow = async (via, limit) => {
    const name = rowTitle(conversation, projectName);
    const { statuses } = await via(['sidebar-state', name, projectName], limit());
    if (statuses.length === 0) return false;
    for (let n = 0; n < statuses.length; n += 1) {
      await via(['open-row', name, projectName, String(n)], limit(PRESS_TIMEOUT_MS));
      // The view switches a moment after the press: read again while the
      // window still shows another title, up to OPEN_READS reads.
      // A namesake still on screen from the row before reads the same title
      // without the marker, so every read up to OPEN_READS is made.
      for (let read = 0; read < OPEN_READS; read += 1) {
        const shown = await via(['snapshot', marker], limit());
        if (shown.truncated !== true && shown.title === conversation && shown.own === true) return true;
        if (read + 1 === OPEN_READS) break;
        // In a cancel's grace `limit` bounds the wait; otherwise a cancel wakes it.
        if (via === bridge) {
          await sleep(OPEN_READ_GAP_MS);
          if (cancelled) throw new Cancelled();
        } else {
          await new Promise((resolve) => setTimeout(resolve, limit(OPEN_READ_GAP_MS).timeoutMs));
        }
      }
    }
    throw new Error(`The run's conversation ${JSON.stringify(conversation)} could not be opened from the sidebar; nothing was pressed in it.`);
  };
  // Takes the app back for the result and opens the run's conversation. In a
  // cancel's grace (`cancel`), cleanup's own uninterrupted calls are used and
  // the whole of it ends PRESS_TIMEOUT_MS before CANCEL_BUDGET_MS from the
  // signal, so Stop still fits. Otherwise the wait for the lock lasts until the
  // run's deadline, whoever holds it, and a cancel interrupts it. Once the lock is taken the run
  // holds the app again (detached is false): if what follows fails, the run's
  // way out presses Stop in its own conversation only, or keeps the lock, and
  // never waits on this lock again.
  const attach = async ({ cancel = false } = {}) => {
    const via = cancel ? call : bridge;
    const until = cancel ? (cancelledAt ?? Date.now()) + CANCEL_BUDGET_MS - PRESS_TIMEOUT_MS : runDeadline;
    const limit = (ms) => {
      if (!cancel) return ms === undefined ? undefined : { timeoutMs: ms };
      const left = until - Date.now();
      if (left < 500) throw new Error('no time was left in the cancel to take the app back');
      return { timeoutMs: Math.min(ms ?? RESTORE_TIMEOUT_MS, left) };
    };
    for (;;) {
      try {
        lockPath = acquireLock(lockFile, lockExpiresAt);
        break;
      } catch (error) {
        if (!(error instanceof Blocked)) throw error;
        if (Date.now() >= until) {
          if (!cancel && Date.now() >= runDeadline) throw new TimedOut(options.timeout);
          throw error;
        }
        if (cancel) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, until - Date.now()))));
        } else {
          await sleep(250);
          if (cancelled) throw new Cancelled();
        }
      }
    }
    detached = false;
    markApp();
    if (!(await openOwnRow(via, limit))) throw new Error(`The Antigravity sidebar no longer lists the run's conversation ${JSON.stringify(conversation)}; nothing was pressed in it.`);
  };
  // The answer's record, created before its step starts and never written
  // through an existing file or link. One that cannot be created, or that
  // exists already, stops the run before anything is pressed.
  const acknowledge = (resume) => {
    if (!resume.ack) return;
    try {
      writeFileSync(resume.ack, `${resume.answer}\n`, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('This request was already answered (its answer is on record); nothing was pressed. If the app asks again, approve the new request it reports.');
      throw new Error(`The answer could not be recorded before it was pressed (${error.code ?? error.message}), so nothing was pressed.`);
    }
  };
  // Only an answer step refused before any press gives the record back, so
  // the request can be approved again.
  const withdraw = (resume) => {
    if (resume.ack) rmSync(resume.ack, { force: true });
  };

  // Puts back what clipboard-get saved: every item whole, or, for a clipboard
  // too large to save whole, its text and its own markers, and the run says
  // what else it held (an image, a file, rich text) was lost.
  const putClipboardBack = async (clipboard) => {
    const lost = 'The clipboard held more than text (an image, a file or rich text) and was too large to save whole; only its text was put back.';
    if (clipboard.other && !Array.isArray(clipboard.items) && !warnings.includes(lost)) warnings.push(lost);
    const restored = await call(['clipboard-restore'], { input: JSON.stringify({ text: clipboard.text ?? null, markers: clipboard.markers ?? [], items: clipboard.items ?? null }), timeoutMs: RESTORE_TIMEOUT_MS }).catch(() => null);
    if (restored?.ok !== true) warnings.push('The clipboard could not be restored.');
  };
  // The clipboard holds the prompt from clipboard-set until the paste is read back.
  let clipboardHeld = false;
  const restoreClipboard = async () => {
    if (!clipboardHeld) return;
    clipboardHeld = false;
    await putClipboardBack(saved.clipboard);
  };
  // The app the user had in front, which every switch to Antigravity gives back.
  let userFront = null;
  const giveFrontBack = async () => {
    if (userFront && userFront !== BUNDLE_ID) await call(['restore', userFront], { timeoutMs: RESTORE_TIMEOUT_MS }).catch(() => warnings.push(`${userFront} could not be brought back to the front.`));
  };
  const restore = async () => {
    if (!saved) return;
    await restoreClipboard();
    saved = null;
    await giveFrontBack();
  };
  // A probe that lets the app come to the front now: the user idle for
  // IDLE_SECONDS, the screen unlocked and the app's window on the Space shown.
  const quiet = (now) => !now.locked && now.on_screen !== false && !(Number(now.idle) < IDLE_SECONDS);
  // Clearing needs the app in front, so it happens only when one bounded probe
  // finds the user quiet again; otherwise the unsent prompt is left for them.
  const clearInput = async () => {
    // At most a probe, the switch and the clear, then the clipboard and the
    // front app (restore()) or the front app alone.
    const needs = 2 * RESTORE_TIMEOUT_MS + PRESS_TIMEOUT_MS + (saved ? 2 : 1) * RESTORE_TIMEOUT_MS;
    if (cancelledAt !== null && Date.now() - cancelledAt + needs > CANCEL_BUDGET_MS) {
      warnings.push('The prompt was left unsent in the Antigravity app input, because the run was cancelled with too little time left to clear it safely; clear it there before sending anything.');
      return;
    }
    const now = await call(['probe'], { timeoutMs: RESTORE_TIMEOUT_MS }).catch(() => null);
    if (!now || !quiet(now)) {
      warnings.push('The prompt was left unsent in the Antigravity app input, because the Mac was in use, the screen was locked or the app was off the Space shown; clear it there before sending anything.');
      return;
    }
    try {
      await call(['front'], { timeoutMs: RESTORE_TIMEOUT_MS });
      await call(['clear-input', UNTITLED], { timeoutMs: PRESS_TIMEOUT_MS });
    } catch {
      warnings.push('The prompt may still be in the Antigravity app input; clear it there before sending anything.');
    }
    // While the run still holds the clipboard, restore() gives the front back.
    if (!saved) await giveFrontBack();
  };
  // Waits until the user has left the keyboard and mouse alone for
  // IDLE_SECONDS, so the switch to the app takes nothing they are typing. A
  // locked screen, or an app with no window on the Space shown (another Space,
  // minimized, hidden or full screen), stops the run before anything moves.
  // Saving the clipboard takes time, so the user is checked again after it,
  // right before the switch, and the wait goes on if they came back.
  const waitForIdleUser = async () => {
    const waitMs = Number(env.AGYBIRD_DESKTOP_IDLE_WAIT_MS) >= 0 && env.AGYBIRD_DESKTOP_IDLE_WAIT_MS !== undefined ? Number(env.AGYBIRD_DESKTOP_IDLE_WAIT_MS) : IDLE_WAIT_MS;
    const pollMs = Number(env.AGYBIRD_DESKTOP_POLL_MS) > 0 ? Number(env.AGYBIRD_DESKTOP_POLL_MS) : IDLE_POLL_MS;
    const until = Date.now() + waitMs;
    const refuse = (now) => {
      if (now.locked) throw new Blocked('screen_locked', 'The screen is locked; unlock it and retry. Nothing was pasted or sent.');
      if (now.on_screen === false) throw new Blocked('not_on_screen', 'The Antigravity window is not on the Space on screen (it is on another Space, minimized, hidden or full screen), and switching to it would move the screen; bring it to this Space and retry. Nothing was pasted or sent.');
    };
    for (;;) {
      const now = await bridge(['probe']);
      refuse(now);
      if (quiet(now)) {
        const clipboard = await bridge(['clipboard-get']);
        const again = await bridge(['probe']);
        refuse(again);
        if (quiet(again)) return { frontmost: again.frontmost, clipboard };
      }
      if (Date.now() >= until) throw new Blocked('user_active', `The keyboard or mouse stayed in use for ${Math.round(waitMs / 1000)} s, so the run did not take the front from the user; retry when the Mac is idle. Nothing was pasted or sent.`);
      await sleep(pollMs);
    }
  };
  // A lock kept for the app (holdLock) was marked before the press and stays.
  const cleanup = async () => {
    await restore();
    if (runRecord && !keepRecord) rmSync(runRecord, { force: true });
    runRecord = null;
    if (lockPath && !holdLock) releaseLock(lockPath);
    lockPath = null;
  };
  const emit = (value) => {
    if (finished) return;
    finished = true;
    process.stdout.write(`${JSON.stringify(value)}\n`);
    // As agybird.mjs: every classified outcome exits 0, only an error exits 1.
    process.exitCode = value.status === 'error' ? 1 : 0;
  };
  const onTerm = () => {
    cancelledAt ??= Date.now();
    cancelled = true;
    interrupt.abort();
    wake();
  };
  process.once('SIGTERM', onTerm);
  process.once('SIGINT', onTerm);

  try {
    const resume = takeResume(argv);
    options = validateRequest(parseArgs(resume.argv));
    const refused = refusedOption(options);
    if (refused) throw new Error(`The desktop transport does not support ${refused}; use the CLI transport (--via cli) for it.`);
    const schema = options.jsonSchema ? JSON.parse(readFileSync(options.jsonSchema, 'utf8')) : null;
    let prompt = buildDelegationPrompt(options, await readPrompt());
    if (schema) prompt += `\nEnd your reply with one fenced \`\`\`json block whose content matches this JSON schema:\n${JSON.stringify(schema)}`;
    if (resume.marker !== null) marker = resume.marker;
    // Last, after any reply instructions, so it changes none of them.
    prompt += `\n\nThe line below only marks this conversation for Agybird. Ignore it and do not mention it in your reply.\n[agybird-run ${marker}]`;

    const platform = env.AGYBIRD_DESKTOP_BRIDGE ? 'darwin' : process.platform;
    checkPlatform(platform);
    const probe = await bridge(['probe']);
    evidence.app_version = probe.version;
    checkProbe(probe, { platform, allowVersion: env.AGYBIRD_DESKTOP_ALLOW_VERSION === '1' });
    const stateDir = env.AGYBIRD_STATE_DIR || join(homedir(), '.agybird');
    lockFile = join(stateDir, 'desktop.lock');
    // A lock an earlier run kept for the app is freed only by evidence that its
    // task ended: the app showing that run's conversation with no run going.
    // Its conversation is the one titled as it recorded and showing its run's marker.
    const abandoned = abandonedAppLock(lockFile);
    let ended = null;
    if (abandoned) {
      const shown = await bridge(['snapshot', abandoned.marker]);
      // A cut-off read is no evidence: the run may lie past the cut. The app
      // may have renamed the conversation since the lock recorded it (2.36),
      // so a titled conversation showing the run's own message is its own.
      if (shown.truncated !== true && shown.title !== null && shown.title !== UNTITLED && shown.own === true && shown.running === false && !shown.dialog) ended = abandoned;
      // Or, only when a whole read shows another conversation (neither the
      // kept one's title nor its run's message, which would be stronger
      // evidence either way), the sidebar lists the kept conversation alone
      // and Idle in the project the lock recorded.
      const elsewhere = shown.truncated !== true && shown.title !== null && shown.title !== abandoned.conversation && shown.own !== true;
      const project = typeof abandoned.project === 'string' && abandoned.project ? abandoned.project : null;
      if (!ended && elsewhere && project && isProjectTitle(abandoned.conversation, project)) {
        let side = null;
        try {
          side = await bridge(['sidebar-state', rowTitle(abandoned.conversation, project), project]);
        } catch (error) {
          if (error instanceof Cancelled) throw error;
        }
        if (side?.grouped === true && side.statuses?.length === 1 && side.statuses[0] === 'Idle') ended = abandoned;
      }
    }
    lockExpiresAt = Date.now() + timeoutToMilliseconds(options.timeout) + LOCK_MARGIN_MS;
    // A lock held by another live run that acts in phases is held only while
    // that run acts (seconds): this run waits for it. A lock freed meanwhile
    // is tried again. Any other holder blocks (a lock is linked into place
    // whole, so an unreadable one is no run's).
    const runsDir = join(stateDir, 'desktop-runs');
    const phased = () => {
      const holder = readLock(lockFile);
      if (holder === null) return true;
      if (holder.unreadable) return false;
      return holder.runs === true && Number.isInteger(holder.pid) && holder.pid > 0 && processIsRunning(holder.pid);
    };
    const startUntil = Date.now() + ATTACH_WAIT_MS;
    for (;;) {
      try {
        lockPath = acquireLock(lockFile, lockExpiresAt, { ended });
        break;
      } catch (error) {
        if (!(error instanceof Blocked) || Date.now() >= startUntil || !phased()) throw error;
        await sleep(250);
        if (cancelled) throw new Cancelled();
      }
    }
    // Under the app lock: the records are counted, and a project created, by one run at a time.
    // A record whose run is gone is removed, unless it says the app may still
    // run its task (app): that one counts until the sidebar shows its
    // conversation alone and Idle, or the user removes it.
    let kept = 0;
    for (const { path, record } of readRecords(runsDir)) {
      if (record.pid === process.pid || recordAlive(record)) continue;
      if (record.app !== true) {
        rmSync(path, { force: true });
        continue;
      }
      if (typeof record.title === 'string' && typeof record.project === 'string' && record.title && record.project) {
        let side = null;
        try {
          side = await bridge(['sidebar-state', rowTitle(record.title, record.project), record.project]);
        } catch (error) {
          if (error instanceof Cancelled) throw error;
        }
        if (side?.grouped === true && side.statuses.length === 1 && side.statuses[0] === 'Idle') {
          rmSync(path, { force: true });
          continue;
        }
      }
      kept += 1;
    }
    const others = readRecords(runsDir).filter(({ record }) => record.pid !== process.pid && (recordAlive(record) || record.app === true)).length;
    if (others >= MAX_RUNS) {
      const why = kept > 0 ? ` ${kept} of them ended without stopping their task in the app; once the app shows no run in one, remove its file in ${runsDir}.` : '';
      throw new Blocked('too_many_runs', `${MAX_RUNS} desktop runs are already going; retry once one finishes.${why} Nothing was pasted or sent.`);
    }
    const resolved = resolveProject(options.cwd, env.AGYBIRD_PROJECTS_DIR || join(homedir(), '.gemini', 'config', 'projects'), { create: resume.question === null });
    const project = resolved.name;
    evidence.project = project;
    if (resolved.created) evidence.project_created = true;
    projectName = project;
    mkdirSync(runsDir, { recursive: true, mode: 0o700 });
    runRecord = join(runsDir, `${marker}.json`);
    writeOwnRecord(false);
    const before = workTree(options.cwd);
    // The reply already on screen when the turn starts; a resumed conversation has one.
    let baselineReply = null;
    if (!before) warnings.push('The workspace is not a git repository, so changes the run made could not be checked.');

    if (resume.question !== null) {
      // Other runs may have switched the view since it asked: its conversation
      // is opened from the sidebar first (B3), checked by title and marker.
      // A sidebar that lists no row of it leaves the view as it is.
      conversation = resume.title;
      await openOwnRow(bridge, (ms) => (ms === undefined ? undefined : { timeoutMs: ms })).catch((error) => {
        if (error instanceof Cancelled) throw error;
      });
      const waiting = await bridge(['snapshot', marker]);
      if (waiting.truncated) throw new Error(`${PARTIAL_TREE}, so the run cannot check the conversation that asked; nothing was pressed. Answer the prompt in the app.`);
      if (waiting.title !== resume.title) throw new Error(`The Antigravity app shows ${JSON.stringify(waiting.title)}, not the conversation that asked (${JSON.stringify(resume.title)}); open that conversation in the app and approve again, or answer it there.`);
      if (waiting.own !== true) throw new Error(`The Antigravity app shows a conversation titled ${JSON.stringify(resume.title)} whose text does not include the asking run's own message, so the run cannot tell it is the one that asked; nothing was pressed. Answer the prompt in the app.`);
      if (!waiting.dialog || permissionRequest(waiting.dialog).question_full !== resume.question) {
        throw new Error(`The Antigravity app no longer asks ${JSON.stringify(resume.question)}; answer it in the app, or start the task again.`);
      }
      conversation = resume.title;
      evidence.conversation_title = conversation;
      evidence.conversation_marker = marker;
      evidence.preset = waiting.preset;
      warnings.push(...presetWarnings(waiting.preset));
      baselineReply = waiting.reply;
      // A refused answer pressed nothing and the app still waits, so only a
      // pressed one, or one whose call failed after it may have pressed, counts as sent.
      answering = true;
      markApp();
      // A cancel before the call starts presses nothing; one during it may have.
      if (cancelled) throw new Cancelled();
      // The record goes first: the step may press and this run be killed
      // before it returns, and the approval must be spent then too. Nothing
      // awaits between the record and the step's start.
      acknowledge(resume);
      try {
        await bridge(['answer', resume.answer, resume.question, conversation, marker]);
      } catch (error) {
        // As with Send: a refusal the bridge reports before any press answered
        // nothing, so its record is withdrawn; a timeout, a crash, a cancel or
        // a failed press may have pressed it, so the app may be running and the
        // answer stays spent, said to be uncertain.
        if (!(error instanceof Cancelled) && / failed: (?:refused|usage|not_found|other_conversation|not_own|question_changed|several_dialogs|several_conversations|outside_conversation|truncated|not_trusted)/.test(error.message)) {
          withdraw(resume);
        } else {
          sent = true;
          evidence.answered = resume.answer;
          evidence.answer_uncertain = true;
          warnings.push(`The answer may have been pressed in the Antigravity app before the run lost track of it (${error.message || 'cancelled'}); it counts as given, and the run was stopped there if it could be.`);
        }
        throw error;
      }
      sent = true;
      evidence.answered = resume.answer;
    } else {
      const ready = await waitForIdleUser();
      userFront = ready.frontmost;
      saved = { clipboard: ready.clipboard };
      // Frontmost before the conversation opens: a composer created while the app
      // is in the background re-mounts when it comes forward and drops the paste.
      const fronted = await bridge(['front']);
      if (fronted.ok !== true) throw new Error('Antigravity did not come to the front, so the run did not open a conversation; nothing was pasted or sent.');
      try {
        await bridge(['new-conversation', project]);
      } catch (error) {
        // A project this run created that the picker does not list yet.
        if (resolved.created && / failed: not_found: project /.test(error.message)) throw new Blocked('project_not_listed', `The Antigravity app does not list the new project ${JSON.stringify(project)} yet; nothing was pasted or sent. Retry, or open the folder as a project in the app.`);
        throw error;
      }
      const opened = await bridge(['snapshot']);
      if (opened.truncated) throw new Error(`${PARTIAL_TREE}, so the run cannot tell its composer from another; nothing was pasted or sent.`);
      checkLabels(opened);
      if (opened.project !== project) throw new Error(`The new conversation opened in project ${JSON.stringify(opened.project)}, not ${JSON.stringify(project)}.`);
      // 2.36 can run the agent elsewhere than this Mac, where the working tree is checked.
      if (opened.location !== null && opened.location !== undefined && opened.location !== 'This Computer') throw new Error(`The new conversation would run the agent on ${JSON.stringify(opened.location)}, not This Computer; nothing was pasted or sent.`);
      evidence.preset = opened.preset;
      warnings.push(...presetWarnings(opened.preset));

      clipboardHeld = true;
      await bridge(['clipboard-set'], { input: prompt });
      pasted = true;
      // Paste, clear and Send act only while the app shows the untitled new conversation.
      try {
        await bridge(['paste-input', UNTITLED], { timeoutMs: 30_000 });
      } catch (error) {
        // Refused before Edit > Paste: the composer holds nothing of the run's.
        if (!(error instanceof Cancelled) && / failed: (?:not_frontmost|not_found|other_conversation|several_conversations|outside_conversation|several_controls|truncated|not_trusted|usage)/.test(error.message)) pasted = false;
        throw error;
      }
      // The composer holds the prompt now: the clipboard and the front go back
      // to the user at once, and the rest (the read back, Send) runs with the
      // app behind. A long prompt (a review's diff) takes seconds to read back.
      await restore();
      const input = await bridge(['read-input', UNTITLED], { timeoutMs: 120_000 });
      // A mismatch, a failed Send or a cancel before Send leaves the composer to
      // be cleared on the way out.
      if (normalized(input.value) !== normalized(prompt)) {
        throw new Error('The prompt in the app input did not match what was pasted (was the app in use?); nothing was sent.');
      }
      // The clipboard restore above is never interrupted, so a cancel that came
      // during it is taken here, before Send: nothing was sent, the composer is
      // cleared and the lock is not kept for the app.
      if (cancelled) throw new Cancelled();
      // Marked first: a cancel that lands while Send is pressed must still stop
      // the run, and a run killed from here on leaves the lock to the app task.
      markApp();
      sent = true;
      let pressed;
      try {
        pressed = await bridge(['send', UNTITLED, project, marker], { timeoutMs: SEND_TIMEOUT_MS });
      } catch (error) {
        // Refused before the press; a timeout or a crash may have pressed it.
        if (!(error instanceof Cancelled) && / failed: (?:not_found|other_conversation|several_conversations|outside_conversation|several_controls|truncated|press_failed|not_trusted|usage)/.test(error.message)) sent = false;
        throw error;
      }
      // The identity of the run's conversation is the title the Send call read
      // once the app titled it, right after pressing Send, and only in a read
      // that also showed the run's own message, marker included, under it; it
      // is never taken from a later read, and a conversation the user created
      // and sent meanwhile lacks the marker.
      if (pressed.refused) throw new OtherConversation(pressed.refused, { unbound: true });
      if (pressed.title) {
        if (!isProjectTitle(pressed.title, project)) throw new OtherConversation(pressed.title);
        conversation = pressed.title;
        evidence.conversation_title = conversation;
        evidence.conversation_marker = marker;
        markApp();
      }
      await restore();
    }

    const deadline = Date.now() + timeoutToMilliseconds(options.timeout);
    runDeadline = deadline;
    const pollMs = Number(env.AGYBIRD_DESKTOP_POLL_MS) > 0 ? Number(env.AGYBIRD_DESKTOP_POLL_MS) : DEFAULT_POLL_MS;
    // Every read is of the run's own conversation, as bound at Send (or untitled
    // if the app had not titled it by then) and showing the run's own message
    // in that same read; any other title, or the title without that message,
    // ends the run unread. Returns false when no title could be read this
    // time, or the read was cut off at the node cap, so the poll is skipped:
    // a cut-off read is never a turn that ended, and the run waits on to its
    // deadline, where Stop is pressed only from a whole read.
    let renamed = false;
    const settleMs = env.AGYBIRD_DESKTOP_SETTLE_MS !== undefined && Number(env.AGYBIRD_DESKTOP_SETTLE_MS) >= 0 ? Number(env.AGYBIRD_DESKTOP_SETTLE_MS) : SETTLE_MS;
    const settleUntil = Date.now() + settleMs;
    // The run's rows in the sidebar: `rows` with their statuses (In Progress,
    // Blocked, Idle; more than one when a namesake shares the title),
    // `ungrouped` when the sidebar shows no status groups or the run has no
    // title to look for (on-screen polling then decides, as before 2.36),
    // `missing` when the groups show no row of it, `error` when no read came.
    const sidebarRead = async () => {
      if (conversation === null) return { kind: 'ungrouped' };
      let side;
      try {
        side = await bridge(['sidebar-state', rowTitle(conversation, project), project]);
      } catch (error) {
        if (error instanceof Cancelled) throw error;
        return { kind: 'error' };
      }
      if (side.grouped !== true) return { kind: 'ungrouped' };
      const statuses = (side.statuses ?? []).filter((status) => typeof status === 'string');
      return statuses.length === 0 ? { kind: 'missing' } : { kind: 'rows', statuses };
    };
    const allRunning = (side) => side.kind === 'rows' && side.statuses.every((status) => status === 'In Progress');
    const follow = (state) => {
      if (state.truncated) {
        const partial = `${PARTIAL_TREE}, so a read could not show whether the task had ended; the run waited for a whole read.`;
        if (!warnings.includes(partial)) warnings.push(partial);
        return false;
      }
      if (state.title === null) return false;
      // 2.36 renames a conversation a few seconds after Send: a bound
      // conversation is followed to its new title, in the same project, only
      // in a read that shows the run's own message under it.
      if (conversation !== null && state.title !== conversation && state.own === true && isProjectTitle(state.title, project)) {
        renamed = true;
        conversation = state.title;
        evidence.conversation_title = conversation;
        markApp();
      }
      if (state.title !== expected()) throw new OtherConversation(state.title, { late: conversation === null });
      if (state.own !== true) throw new OtherConversation(state.title, { unmarked: true });
      return true;
    };
    const changesSince = () => {
      const now = before && workTree(options.cwd);
      if (!before) return false;
      if (!now) {
        warnings.push('The working tree could not be read again, so changes the run made were not checked.');
        return options.mode === 'read';
      }
      evidence.changed_files = changedFiles(before, now);
      if (before.head !== now.head) warnings.push('HEAD moved during the run.');
      return evidence.changed_files.length > 0 || before.head !== now.head;
    };
    let state;
    let sawRunning = false;
    // Sidebar reads in a row that found no row of the run's (B2: 3 end the run).
    let misses = 0;
    const missed = (side) => {
      misses = side.kind === 'missing' || side.kind === 'error' ? misses + 1 : 0;
      if (misses >= 3) throw new Error(`The Antigravity sidebar did not list the run's conversation ${JSON.stringify(conversation)} for ${misses} reads in a row; the run stopped watching it. Check it in the app.`);
    };
    for (;;) {
      await sleep(pollMs);
      // Once the title has settled, the app is given to other runs while the
      // agent works, when the sidebar shows the run's row, and any namesake's,
      // In Progress.
      if (!detached && lockPath && !holdLock && conversation !== null && (renamed || Date.now() >= settleUntil)) {
        const side = await sidebarRead();
        if (allRunning(side)) {
          sawRunning = true;
          detach();
        }
      }
      if (detached) {
        const side = await sidebarRead();
        if (side.kind === 'rows') sawRunning = true;
        missed(side);
        if (allRunning(side) || side.kind === 'missing' || side.kind === 'error') {
          if (Date.now() >= deadline) throw new TimedOut(options.timeout);
          continue;
        }
        // Blocked, Idle, or a sidebar no longer grouped: read it on screen.
        await attach();
      }
      state = await bridge(['snapshot', marker]);
      if (!follow(state)) {
        if (Date.now() >= deadline) throw new TimedOut(options.timeout);
        continue;
      }
      if (state.dialog && state.dialog.permission !== true) {
        // An agent's question is the user's to answer in the app; it is never
        // answered through the permission flow. Its text is capped as a
        // permission request's is.
        turnOver = true;
        const asked = permissionRequest(state.dialog);
        if (changesSince() && options.mode === 'read') warnings.push('The run changed the working tree in read mode before the agent asked its question.');
        evidence.agent_question = { question: asked.question, question_truncated: asked.question_truncated, options: asked.options };
        throw new Blocked('agent_question', `The agent in the Antigravity app asked a question and waits for the answer there: ${JSON.stringify(asked.question)} (options: ${asked.options.join('; ')}). Answer it in the app; Agybird does not answer agent questions.`);
      }
      if (state.dialog) {
        if (changesSince() && options.mode === 'read') {
          // Declining lets the agent go on, so the run is then stopped on the way out.
          await call(['answer', 'Skip', permissionRequest(state.dialog).question_full, expected(), marker], { timeoutMs: PRESS_TIMEOUT_MS }).catch(() => warnings.push('The permission prompt could not be declined; answer it in the app.'));
          throw new Error('The run changed the working tree in read mode before it asked for a permission; Agybird declined the prompt.');
        }
        turnOver = true;
        await cleanup();
        return emit(envelope({ status: 'needs_permission', category: options.category, requests: [permissionRequest(state.dialog)], warnings: [...warnings, 'The run is waiting in the Antigravity app for an answer to a permission prompt.'], evidence }));
      }
      if (state.running) sawRunning = true;
      // A turn has ended once it was seen running, or once a new reply replaced the one on screen.
      if (!state.running && state.reply !== null && (sawRunning || state.reply !== baselineReply)) {
        // ...and only once the sidebar shows no row of its title In Progress
        // (C4): an interim message while a command runs is not the reply. A
        // sidebar with no status groups leaves it to the screen; a read that
        // found no row decides nothing, and 3 in a row end the run.
        const side = await sidebarRead();
        if (side.kind === 'ungrouped') break;
        missed(side);
        if (side.kind === 'rows' && !side.statuses.includes('In Progress')) break;
        sawRunning = true;
      }
      if (Date.now() >= deadline) throw new TimedOut(options.timeout);
    }
    turnOver = true;

    // The accessibility text is rendered Markdown, split into words and without
    // code fences; the app's Copy button gives the reply as written.
    // Copy reads the reply back in the same call, and the clipboard is put back
    // right after, so the reply sits there only that long.
    let response = state.reply;
    const clipboard = await bridge(['clipboard-get']);
    try {
      response = (await bridge(['copy-reply', expected(), marker])).text ?? state.reply;
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      warnings.push(`The reply could not be copied from the app (${error.message}); its on-screen text is returned instead.`);
    } finally {
      await putClipboardBack(clipboard);
    }

    let status = 'success';
    let structured = null;
    if (schema) {
      try {
        structured = structuredFromReply(response, schema);
      } catch (error) {
        status = 'error';
        warnings.push(error.message);
      }
    }
    if (changesSince()) {
      if (options.mode === 'read') {
        status = 'error';
        warnings.push('The run changed the working tree in read mode.');
      } else {
        try {
          evidence.diff_stat = diffStat(collectScope({ cwd: options.cwd, scope: 'working-tree' }).diff, evidence.changed_files);
        } catch {
          warnings.push('The diff stat of the changed files could not be read.');
        }
      }
    }
    // Opt-in (setup --archive-finished on): the turn is over and its reply
    // read, so the run's conversation is archived from its sidebar row, only
    // when that row is alone and Idle; it stays in the app, out of the sidebar.
    if (env.AGYBIRD_DESKTOP_ARCHIVE === '1' && conversation !== null && !cancelled) {
      try {
        await call(['archive-row', rowTitle(conversation, project), project], { timeoutMs: PRESS_TIMEOUT_MS });
        evidence.archived = true;
      } catch (error) {
        warnings.push(`The run's conversation was not archived in the app (${error.message}); it stays in the sidebar.`);
      }
    }
    await cleanup();
    emit(envelope({ status, category: options.category, response, structured, warnings, evidence }));
  } catch (caught) {
    let error = caught;
    // Whatever ended the run after Send (a cancel, a timeout, a failed read), the
    // app may still run the task: Stop is pressed in the run's own conversation
    // before the lock goes. Another conversation on screen is never pressed.
    const running = sent && !turnOver;
    let stopped = false;
    if (running) markApp();
    // A run waiting with the app free takes it back, briefly, to press Stop.
    // A run waiting with the app free takes it back, briefly, to press Stop;
    // once it holds the lock again (even if opening the row failed), Stop is
    // tried in its own conversation only, checked by title and marker.
    if (running && detached && !(caught instanceof OtherConversation)) await attach({ cancel: true }).catch(() => warnings.push('The app could not be taken back from other runs in time to press Stop.'));
    if (running && !detached && !(caught instanceof OtherConversation)) stopped = await call(['stop', expected(), marker], { timeoutMs: PRESS_TIMEOUT_MS }).then(() => true, () => false);
    if (running && !stopped) {
      // The lock, marked for the app before the press, stays until evidence
      // frees it; a run that no longer holds it keeps its run record instead.
      holdLock = Boolean(lockPath);
      keepRecord = !holdLock && Boolean(runRecord);
      let until = '';
      if (holdLock) {
        until = conversation
          ? ` Other desktop runs are refused until one finds the app showing ${JSON.stringify(conversation)} with no run, or its sidebar listing it alone under Idle, or until you remove ${lockPath} once it shows none.`
          : ` Other desktop runs are refused until you remove ${lockPath} once the app shows no run.`;
      } else if (keepRecord) {
        until = ` It counts among the ${MAX_RUNS} desktop runs until the sidebar shows it Idle, or until you remove ${runRecord} once it shows no run.`;
      }
      warnings.push(`The run may still be going in the Antigravity app: Stop could not be pressed in its conversation. Stop it there.${until}`);
    }
    if (pasted && !sent) await clearInput();
    if (cancelled) {
      if (!sent) error = new Error(answering ? 'The run was cancelled before the answer was pressed.' : 'The run was cancelled before the prompt was sent.');
      else error = new Error(stopped ? 'The run was cancelled and stopped in the app.' : 'The run was cancelled, but Stop could not be pressed in the app.');
    } else if (caught instanceof TimedOut) {
      error = new Error(`The run timed out after ${options.timeout}${stopped ? ' and was stopped in the app' : ''}.`);
    }
    await cleanup();
    if (error instanceof Blocked) evidence.blocked_reason = error.reason;
    emit(envelope({ status: error instanceof Blocked ? 'blocked' : 'error', category: options?.category, warnings: [...warnings, error.message], evidence }));
    process.stderr.write(`agybird desktop: ${error.message}\n`);
  } finally {
    process.removeListener('SIGTERM', onTerm);
    process.removeListener('SIGINT', onTerm);
  }
}

if (isDirectExecution(process.argv[1], import.meta.url)) {
  main();
}
