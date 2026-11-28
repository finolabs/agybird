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
import { join } from 'node:path';

import { buildDelegationPrompt, findProjectForWorkspace, isDirectExecution, parseArgs, readPrompt, timeoutToMilliseconds, validateRequest } from './agybird.mjs';
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
// still make fit the 20 s the companion gives it before it kills the run: a
// decline and Stop (5 s each), then the clipboard and the front app (3 s
// each), 16 s at most; clearing the composer (3 + 5 s) replaces Stop. The lock
// already says the app may run before any of them (markLockForApp).
const PRESS_TIMEOUT_MS = 5_000;
const RESTORE_TIMEOUT_MS = 3_000;
// The app comes to the front only once the user has left the keyboard and
// mouse alone this long, waiting at most IDLE_WAIT_MS for it.
const IDLE_SECONDS = 3;
const IDLE_WAIT_MS = 120_000;
const IDLE_POLL_MS = 500;

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

// One desktop run at a time on this machine: they share one app and one
// clipboard. The lock is linked into place whole, never seen empty. A free place
// is taken by the link alone; a stale lock is removed only by the run holding
// the takeover guard, after it reads the lock again under the guard. No run can
// then remove a lock another run has just taken, so at most one run holds it.
// `hooks.stale` runs once a run holds the guard over a stale lock (tests only).
// `ended` is an app lock the caller saw the app to be done with.
export function acquireLock(path, expiresAt, { pid = process.pid, hooks = {}, ended = null } = {}) {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const content = JSON.stringify({ pid, expiresAt });
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
    const where = holder.conversation ? ` in its conversation ${JSON.stringify(holder.conversation)}; once the app shows that conversation with no run, retry` : '';
    throw new Blocked('locked', `An earlier desktop run may still be going in the Antigravity app${where}. Or, once you are sure the app runs nothing for it, remove ${path}.`);
  }
  throw new Blocked('locked', 'Another desktop run is using the Antigravity app; retry once it finishes.');
}

// From just before Send (or an answer) is pressed, the lock says the app may
// run this task, with its conversation once known, so it outlives this process
// however it ends, a kill during cleanup included. Released only by a run that
// saw the task end, by evidence (lockHeld), or by the user.
function markLockForApp(path, expiresAt, conversation, marker) {
  if (readLock(path)?.pid !== process.pid) return;
  const temporary = `${path}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, JSON.stringify({ pid: process.pid, expiresAt, app: true, conversation, marker }), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

function releaseLock(path) {
  if (readLock(path)?.pid === process.pid) rmSync(path, { force: true });
}

// The app lists projects by name only, so the name must lead to this folder alone.
function projectName(cwd, directory) {
  const found = findProjectForWorkspace(cwd, directory);
  const name = found?.document?.name;
  if (!name) throw new Blocked('no_project', `Antigravity has no project for ${cwd}; open the folder as a project in the app first.`);
  const namesakes = readdirSync(directory).filter((entry) => entry.endsWith('.json')).filter((entry) => {
    try {
      return JSON.parse(readFileSync(join(directory, entry), 'utf8')).name === name;
    } catch {
      return false;
    }
  });
  if (namesakes.length > 1) throw new Blocked('ambiguous_project', `${namesakes.length} Antigravity projects are named ${JSON.stringify(name)}; rename all but the one for ${cwd} in the app.`);
  return name;
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

export async function main(argv = process.argv.slice(2), env = process.env) {
  // A signal marks the run cancelled and interrupts the step in flight; the run
  // then cleans up itself, so cleanup never races a bridge call still running.
  let cancelled = false;
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
  let lockExpiresAt = null;
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
  const markApp = () => {
    if (lockPath) markLockForApp(lockPath, lockExpiresAt, conversation, marker);
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
    await call(['clipboard-restore'], { input: JSON.stringify({ text: clipboard.text ?? null, markers: clipboard.markers ?? [], items: clipboard.items ?? null }), timeoutMs: RESTORE_TIMEOUT_MS }).catch(() => warnings.push('The clipboard could not be restored.'));
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
  // Clearing needs the app in front, which the user may have changed meanwhile.
  const clearInput = async () => {
    try {
      await call(['front'], { timeoutMs: RESTORE_TIMEOUT_MS });
      await call(['clear-input', UNTITLED], { timeoutMs: PRESS_TIMEOUT_MS });
    } catch {
      warnings.push('The prompt may still be in the Antigravity app input; clear it there before sending anything.');
    }
    await giveFrontBack();
  };
  // Waits until the user has left the keyboard and mouse alone for
  // IDLE_SECONDS, so the switch to the app takes nothing they are typing. A
  // locked screen, or an app with no window on the Space shown (another Space,
  // minimized, hidden or full screen), stops the run before anything moves.
  const waitForIdleUser = async () => {
    const waitMs = Number(env.AGYBIRD_DESKTOP_IDLE_WAIT_MS) >= 0 && env.AGYBIRD_DESKTOP_IDLE_WAIT_MS !== undefined ? Number(env.AGYBIRD_DESKTOP_IDLE_WAIT_MS) : IDLE_WAIT_MS;
    const pollMs = Number(env.AGYBIRD_DESKTOP_POLL_MS) > 0 ? Number(env.AGYBIRD_DESKTOP_POLL_MS) : IDLE_POLL_MS;
    const until = Date.now() + waitMs;
    for (;;) {
      const now = await bridge(['probe']);
      if (now.locked) throw new Blocked('screen_locked', 'The screen is locked; unlock it and retry. Nothing was pasted or sent.');
      if (now.on_screen === false) throw new Blocked('not_on_screen', 'The Antigravity window is not on the Space on screen (it is on another Space, minimized, hidden or full screen), and switching to it would move the screen; bring it to this Space and retry. Nothing was pasted or sent.');
      if (!(Number(now.idle) < IDLE_SECONDS)) return now;
      if (Date.now() >= until) throw new Blocked('user_active', `The keyboard or mouse stayed in use for ${Math.round(waitMs / 1000)} s, so the run did not take the front from the user; retry when the Mac is idle. Nothing was pasted or sent.`);
      await sleep(pollMs);
    }
  };
  // A lock kept for the app (holdLock) was marked before the press and stays.
  const cleanup = async () => {
    await restore();
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
    const project = projectName(options.cwd, env.AGYBIRD_PROJECTS_DIR || join(homedir(), '.gemini', 'config', 'projects'));
    const lockFile = join(env.AGYBIRD_STATE_DIR || join(homedir(), '.agybird'), 'desktop.lock');
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
    }
    lockExpiresAt = Date.now() + timeoutToMilliseconds(options.timeout) + LOCK_MARGIN_MS;
    lockPath = acquireLock(lockFile, lockExpiresAt, { ended });
    const before = workTree(options.cwd);
    // The reply already on screen when the turn starts; a resumed conversation has one.
    let baselineReply = null;
    if (!before) warnings.push('The workspace is not a git repository, so changes the run made could not be checked.');

    if (resume.question !== null) {
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
      const idle = await waitForIdleUser();
      userFront = idle.frontmost;
      saved = { clipboard: await bridge(['clipboard-get']) };
      // Frontmost before the conversation opens: a composer created while the app
      // is in the background re-mounts when it comes forward and drops the paste.
      await bridge(['front']);
      await bridge(['new-conversation', project]);
      const opened = await bridge(['snapshot']);
      if (opened.truncated) throw new Error(`${PARTIAL_TREE}, so the run cannot tell its composer from another; nothing was pasted or sent.`);
      checkLabels(opened);
      if (opened.project !== project) throw new Error(`The new conversation opened in project ${JSON.stringify(opened.project)}, not ${JSON.stringify(project)}.`);
      // 2.36 can run the agent elsewhere than this Mac, where the working tree is checked.
      if (opened.location !== null && opened.location !== undefined && opened.location !== 'This Computer') throw new Error(`The new conversation would run the agent on ${JSON.stringify(opened.location)}, not This Computer; nothing was pasted or sent.`);
      evidence.preset = opened.preset;
      warnings.push(...presetWarnings(opened.preset));

      pasted = true;
      clipboardHeld = true;
      await bridge(['clipboard-set'], { input: prompt });
      // Paste, clear and Send act only while the app shows the untitled new conversation.
      await bridge(['paste-input', UNTITLED], { timeoutMs: 30_000 });
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
    const pollMs = Number(env.AGYBIRD_DESKTOP_POLL_MS) > 0 ? Number(env.AGYBIRD_DESKTOP_POLL_MS) : DEFAULT_POLL_MS;
    // Every read is of the run's own conversation, as bound at Send (or untitled
    // if the app had not titled it by then) and showing the run's own message
    // in that same read; any other title, or the title without that message,
    // ends the run unread. Returns false when no title could be read this
    // time, or the read was cut off at the node cap, so the poll is skipped:
    // a cut-off read is never a turn that ended, and the run waits on to its
    // deadline, where Stop is pressed only from a whole read.
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
    for (;;) {
      await sleep(pollMs);
      state = await bridge(['snapshot', marker]);
      if (!follow(state)) {
        if (Date.now() >= deadline) throw new TimedOut(options.timeout);
        continue;
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
      if (!state.running && state.reply !== null && (sawRunning || state.reply !== baselineReply)) break;
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
    if (running && !(caught instanceof OtherConversation)) stopped = await call(['stop', expected(), marker], { timeoutMs: PRESS_TIMEOUT_MS }).then(() => true, () => false);
    if (running && !stopped) {
      // The lock, marked for the app before the press, stays until evidence frees it.
      holdLock = Boolean(lockPath);
      const until = conversation
        ? ` Other desktop runs are refused until one finds the app showing ${JSON.stringify(conversation)} with no run, or until you remove ${lockPath} once it shows none.`
        : ` Other desktop runs are refused until you remove ${lockPath} once the app shows no run.`;
      warnings.push(`The run may still be going in the Antigravity app: Stop could not be pressed in its conversation. Stop it there.${holdLock ? until : ''}`);
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
