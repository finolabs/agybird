#!/usr/bin/env node
// The desktop transport's runner: the same arguments, stdin prompt and one-line
// JSON envelope as agybird.mjs, but the task runs in a new conversation of the
// Antigravity desktop app, driven through macOS Accessibility (desktop-ax.js).
// Every run starts a new conversation; the app's permissions preset is used as
// the user set it and never changed.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { buildDelegationPrompt, findProjectForWorkspace, isDirectExecution, parseArgs, readPrompt, timeoutToMilliseconds, validateRequest } from './agybird.mjs';
import { callBridge } from './lib/desktop-bridge.mjs';
import { Blocked, changedFiles, diffStat, checkLabels, checkPlatform, checkProbe, envelope, permissionRequest, presetWarnings, refusedOption, structuredFromReply } from './lib/desktop-state.mjs';
import { collectScope } from './lib/scope.mjs';

const BUNDLE_ID = 'com.google.antigravity';
const DEFAULT_POLL_MS = 2_500;

class Cancelled extends Error {}

class TimedOut extends Error {
  constructor(timeout) {
    super(`The run timed out after ${timeout}.`);
  }
}

class OtherConversation extends Error {
  constructor(title, { late = false } = {}) {
    super(late
      ? `The Antigravity app showed a titled conversation (${JSON.stringify(title)}) only after Send had returned without one, so the run cannot tell it from another conversation; it stopped reading and pressed nothing. Check the run's conversation in the app.`
      : `The Antigravity app now shows another conversation (${JSON.stringify(title)}); the run stopped reading and pressed nothing there. Check the run's conversation in the app.`);
  }
}

// Send waits in the app for the new conversation's title, which identifies it.
const SEND_TIMEOUT_MS = 45_000;

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

function lockHeld(path, holder) {
  if (holder.unreadable) {
    try {
      return Date.now() - statSync(path).mtimeMs < UNREADABLE_LOCK_MS;
    } catch {
      return false;
    }
  }
  if (Number.isFinite(holder.expiresAt) && Date.now() > holder.expiresAt) return false;
  // Kept by a run that ended while the app may still be running its task.
  if (holder.app === true) return Number.isFinite(holder.expiresAt);
  return Number.isInteger(holder.pid) && holder.pid > 0 && processIsRunning(holder.pid);
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
export function acquireLock(path, expiresAt, { pid = process.pid, hooks = {} } = {}) {
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (link()) return path;
    const holder = readLock(path);
    if (holder === null) continue;
    if (lockHeld(path, holder) || !takeGuard(guard)) break;
    try {
      hooks.stale?.();
      const again = readLock(path);
      if (again !== null && lockHeld(path, again)) break;
      rmSync(path, { force: true });
      if (link()) return path;
    } finally {
      rmSync(guard, { force: true });
    }
  }
  throw new Blocked('locked', 'Another desktop run is using the Antigravity app; retry once it finishes.');
}

// After a run that could not press Stop, its lock stays, past the end of this
// process, until the run's own deadline: the app may still run that task.
function keepLockForApp(path, expiresAt) {
  if (readLock(path)?.pid !== process.pid) return;
  const temporary = `${path}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, JSON.stringify({ pid: process.pid, expiresAt, app: true }), { mode: 0o600, flag: 'wx' });
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

// `--resume-dialog <question> --resume-title <conversation title>` belong to this
// runner only: after the user's yes, it answers the prompt the app is waiting on
// in that conversation instead of sending a task.
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
  const answer = take('--resume-answer') ?? '1';
  if ((question === null) !== (title === null)) throw new Error('--resume-dialog and --resume-title go together');
  if (!['1', 'Skip'].includes(answer)) throw new Error('--resume-answer is 1 or Skip');
  return { argv: rest, question, title, answer };
}

// A new conversation's web area reads "Antigravity" until the app titles it.
const UNTITLED = 'Antigravity';

// Links in the composer are separate nodes, so whitespace around them differs;
// every other character must read back in order.
const normalized = (text) => String(text ?? '').replace(/\s+/g, '');

export async function main(argv = process.argv.slice(2), env = process.env) {
  // A signal only marks the run cancelled; the run itself stops at its next step,
  // so cleanup never races a bridge call that is still in flight.
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
  // A resumed run pressing its answer: a cancel then may have let the app go on.
  let answering = false;
  // Set once the turn ended or the app waits on a prompt: nothing runs any more.
  let turnOver = false;
  // Set when the app may still run the task but Stop could not be pressed.
  let holdLock = false;
  let runDeadline = null;
  let finished = false;
  // The title of the run's own conversation, as the Send call read it right
  // after pressing Send; null while it is the untitled new conversation.
  let conversation = null;
  const expected = () => conversation ?? UNTITLED;

  const restore = async () => {
    if (!saved) return;
    const { clipboard, frontmost } = saved;
    saved = null;
    if (pasted) {
      await (clipboard === null ? call(['clipboard-set', '--empty']) : call(['clipboard-set'], { input: clipboard })).catch(() => warnings.push('The clipboard could not be restored.'));
    }
    if (frontmost && frontmost !== BUNDLE_ID) await call(['restore', frontmost]).catch(() => warnings.push(`${frontmost} could not be brought back to the front.`));
  };
  // Clearing needs the app in front, which the user may have changed meanwhile.
  const clearInput = async () => {
    try {
      await call(['front']);
      await call(['clear-input', UNTITLED]);
    } catch {
      warnings.push('The prompt may still be in the Antigravity app input; clear it there before sending anything.');
    }
  };
  const cleanup = async () => {
    await restore();
    if (lockPath) (holdLock ? keepLockForApp(lockPath, runDeadline) : releaseLock(lockPath));
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

    const platform = env.AGYBIRD_DESKTOP_BRIDGE ? 'darwin' : process.platform;
    checkPlatform(platform);
    const probe = await bridge(['probe']);
    evidence.app_version = probe.version;
    checkProbe(probe, { platform, allowVersion: env.AGYBIRD_DESKTOP_ALLOW_VERSION === '1' });
    const project = projectName(options.cwd, env.AGYBIRD_PROJECTS_DIR || join(homedir(), '.gemini', 'config', 'projects'));
    runDeadline = Date.now() + timeoutToMilliseconds(options.timeout);
    lockPath = acquireLock(join(env.AGYBIRD_STATE_DIR || join(homedir(), '.agybird'), 'desktop.lock'), runDeadline + LOCK_MARGIN_MS);
    const before = workTree(options.cwd);
    // The reply already on screen when the turn starts; a resumed conversation has one.
    let baselineReply = null;
    if (!before) warnings.push('The workspace is not a git repository, so changes the run made could not be checked.');

    if (resume.question !== null) {
      const waiting = await bridge(['snapshot']);
      if (waiting.title !== resume.title) throw new Error(`The Antigravity app shows ${JSON.stringify(waiting.title)}, not the conversation that asked (${JSON.stringify(resume.title)}); open that conversation in the app and approve again, or answer it there.`);
      if (!waiting.dialog || permissionRequest(waiting.dialog).question_full !== resume.question) {
        throw new Error(`The Antigravity app no longer asks ${JSON.stringify(resume.question)}; answer it in the app, or start the task again.`);
      }
      conversation = resume.title;
      evidence.conversation_title = conversation;
      evidence.preset = waiting.preset;
      warnings.push(...presetWarnings(waiting.preset));
      baselineReply = waiting.reply;
      // A refused answer pressed nothing and the app still waits, so only a
      // pressed one (or one cut off by a cancel) counts as sent.
      answering = true;
      await bridge(['answer', resume.answer, resume.question, conversation]);
      sent = true;
      // Tells the companion the answer was pressed, so only now is it spent.
      evidence.answered = resume.answer;
    } else {
      saved = { clipboard: (await bridge(['clipboard-get'])).text, frontmost: probe.frontmost };
      // Frontmost before the conversation opens: a composer created while the app
      // is in the background re-mounts when it comes forward and drops the paste.
      await bridge(['front']);
      await bridge(['new-conversation', project]);
      const opened = await bridge(['snapshot']);
      checkLabels(opened);
      if (opened.project !== project) throw new Error(`The new conversation opened in project ${JSON.stringify(opened.project)}, not ${JSON.stringify(project)}.`);
      evidence.preset = opened.preset;
      warnings.push(...presetWarnings(opened.preset));

      pasted = true;
      await bridge(['clipboard-set'], { input: prompt });
      // A long prompt (a review's diff) takes seconds to read back line by line.
      // Paste, clear and Send act only while the app shows the untitled new conversation.
      const input = await bridge(['paste-input', UNTITLED], { timeoutMs: 120_000 });
      // A mismatch, a failed Send or a cancel before Send leaves the composer to
      // be cleared on the way out.
      if (normalized(input.value) !== normalized(prompt)) {
        throw new Error('The prompt in the app input did not match what was pasted (was the app in use?); nothing was sent.');
      }
      // Marked first: a cancel that lands while Send is pressed must still stop the run.
      sent = true;
      let pressed;
      try {
        pressed = await bridge(['send', UNTITLED], { timeoutMs: SEND_TIMEOUT_MS });
      } catch (error) {
        // Refused before the press; a timeout or a crash may have pressed it.
        if (!(error instanceof Cancelled) && / failed: (?:not_found|other_conversation|press_failed|not_trusted|usage)/.test(error.message)) sent = false;
        throw error;
      }
      // The identity of the run's conversation is the title the Send call read
      // once the app titled it, right after pressing Send; it is never taken
      // from a later read, which could show a conversation the user opened.
      if (pressed.title) {
        if (!String(pressed.title).endsWith(` - ${project} - ${UNTITLED}`)) throw new OtherConversation(pressed.title);
        conversation = pressed.title;
        evidence.conversation_title = conversation;
      }
      await restore();
    }

    const deadline = Date.now() + timeoutToMilliseconds(options.timeout);
    const pollMs = Number(env.AGYBIRD_DESKTOP_POLL_MS) > 0 ? Number(env.AGYBIRD_DESKTOP_POLL_MS) : DEFAULT_POLL_MS;
    // Every read is of the run's own conversation, as bound at Send (or untitled
    // if the app had not titled it by then); any other title on screen ends the
    // run unread. Returns false when no title could be read this time, so the
    // poll is skipped.
    const follow = (state) => {
      if (state.title === null) return false;
      if (state.title !== expected()) throw new OtherConversation(state.title, { late: conversation === null });
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
      state = await bridge(['snapshot']);
      if (!follow(state)) {
        if (Date.now() >= deadline) throw new TimedOut(options.timeout);
        continue;
      }
      if (state.dialog) {
        if (changesSince() && options.mode === 'read') {
          // Declining lets the agent go on, so the run is then stopped on the way out.
          await call(['answer', 'Skip', permissionRequest(state.dialog).question_full, expected()]).catch(() => warnings.push('The permission prompt could not be declined; answer it in the app.'));
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
    let response = state.reply;
    const clipboard = (await bridge(['clipboard-get'])).text;
    try {
      await bridge(['copy-reply', expected()]);
      response = (await bridge(['clipboard-get'])).text ?? state.reply;
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      warnings.push(`The reply could not be copied from the app (${error.message}); its on-screen text is returned instead.`);
    } finally {
      await (clipboard === null ? call(['clipboard-set', '--empty']) : call(['clipboard-set'], { input: clipboard })).catch(() => warnings.push('The clipboard could not be restored.'));
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
    const running = (sent || (answering && cancelled)) && !turnOver;
    let stopped = false;
    if (running && !(caught instanceof OtherConversation)) stopped = await call(['stop', expected()]).then(() => true, () => false);
    if (running && !stopped) {
      holdLock = Boolean(lockPath);
      // Until the run's deadline, and a few minutes at least after a timeout.
      runDeadline = Math.max(runDeadline ?? 0, Date.now() + LOCK_MARGIN_MS);
      warnings.push(`The run may still be going in the Antigravity app: Stop could not be pressed in its conversation. Stop it there.${holdLock ? ` Other desktop runs are refused until ${new Date(runDeadline).toLocaleTimeString()}, or until you remove ${lockPath} once the app shows no run.` : ''}`);
    }
    if (pasted && !sent) await clearInput();
    if (cancelled) {
      if (!sent && !answering) error = new Error('The run was cancelled before the prompt was sent.');
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
