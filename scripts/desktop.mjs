#!/usr/bin/env node
// The desktop transport's runner: the same arguments, stdin prompt and one-line
// JSON envelope as agybird.mjs, but the task runs in a new conversation of the
// Antigravity desktop app, driven through macOS Accessibility (desktop-ax.js).
// Every run starts a new conversation; the app's permissions preset is used as
// the user set it and never changed.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { buildDelegationPrompt, findProjectForWorkspace, isDirectExecution, parseArgs, readPrompt, timeoutToMilliseconds, validateRequest } from './agybird.mjs';
import { callBridge } from './lib/desktop-bridge.mjs';
import { Blocked, changedFiles, checkLabels, checkProbe, envelope, permissionRequest, presetWarnings, refusedOption, structuredFromReply } from './lib/desktop-state.mjs';
import { collectScope } from './lib/scope.mjs';

const BUNDLE_ID = 'com.google.antigravity';
const DEFAULT_POLL_MS = 2_500;

class Cancelled extends Error {}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// One desktop run at a time on this machine: they share one app and one clipboard.
function acquireLock(path) {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx', mode: 0o600 });
      return path;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = Number(readFileSync(path, 'utf8'));
      if (Number.isInteger(holder) && holder > 0 && processIsRunning(holder)) break;
      rmSync(path, { force: true });
    }
  }
  throw new Blocked('locked', 'Another desktop run is using the Antigravity app; retry once it finishes.');
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

// The working tree as file hashes, read with the repository's git programs off.
// Outside a repository there is nothing to compare.
function workTree(cwd) {
  let scope;
  try {
    scope = collectScope({ cwd, scope: 'working-tree', maxBytes: 1 });
  } catch {
    return null;
  }
  const head = spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: scope.root, encoding: 'utf8', shell: false, windowsHide: true }).stdout?.trim() ?? '';
  return { head, hashes: Object.fromEntries(scope.files.map((file) => [file, fileHash(join(scope.root, file))])) };
}

// `--resume-dialog <question>` belongs to this runner only: after the user's
// yes, it answers the prompt the app is waiting on instead of sending a task.
function takeResume(argv) {
  const index = argv.indexOf('--resume-dialog');
  if (index < 0) return { argv, question: null };
  const question = argv[index + 1];
  if (question === undefined || question.startsWith('--')) throw new Error('--resume-dialog requires the question being answered');
  return { argv: [...argv.slice(0, index), ...argv.slice(index + 2)], question };
}

const normalized = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

export async function main(argv = process.argv.slice(2), env = process.env) {
  // A signal only marks the run cancelled; the run itself stops at its next step,
  // so cleanup never races a bridge call that is still in flight.
  let cancelled = false;
  let wake = () => {};
  const call = (args, options) => callBridge(args, { env, ...options });
  const bridge = async (args, options) => {
    if (cancelled) throw new Cancelled();
    const value = await call(args, options);
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
  let sent = false;
  let finished = false;

  const restore = async () => {
    if (!saved) return;
    const { clipboard, frontmost } = saved;
    saved = null;
    if (pasted) {
      await (clipboard === null ? call(['clipboard-set', '--empty']) : call(['clipboard-set'], { input: clipboard })).catch(() => warnings.push('The clipboard could not be restored.'));
    }
    if (frontmost && frontmost !== BUNDLE_ID) await call(['restore', frontmost]).catch(() => warnings.push(`${frontmost} could not be brought back to the front.`));
  };
  const cleanup = async () => {
    await restore();
    if (lockPath) rmSync(lockPath, { force: true });
    lockPath = null;
  };
  const emit = (value) => {
    if (finished) return;
    finished = true;
    process.stdout.write(`${JSON.stringify(value)}\n`);
    process.exitCode = value.status === 'success' || value.status === 'needs_permission' ? 0 : 1;
  };
  const onTerm = () => {
    cancelled = true;
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

    const probe = await bridge(['probe']);
    evidence.app_version = probe.version;
    checkProbe(probe, { platform: env.AGYBIRD_DESKTOP_BRIDGE ? 'darwin' : process.platform, allowVersion: env.AGYBIRD_DESKTOP_ALLOW_VERSION === '1' });
    const project = projectName(options.cwd, env.AGYBIRD_PROJECTS_DIR || join(homedir(), '.gemini', 'config', 'projects'));
    lockPath = acquireLock(join(env.AGYBIRD_STATE_DIR || join(homedir(), '.agybird'), 'desktop.lock'));
    const before = workTree(options.cwd);
    if (!before) warnings.push('The workspace is not a git repository, so changes the run made could not be checked.');

    if (resume.question !== null) {
      const waiting = await bridge(['snapshot']);
      if (!waiting.dialog || permissionRequest(waiting.dialog).question !== resume.question) {
        throw new Error(`The Antigravity app no longer asks ${JSON.stringify(resume.question)}; answer it in the app, or start the task again.`);
      }
      evidence.preset = waiting.preset;
      warnings.push(...presetWarnings(waiting.preset));
      sent = true;
      await bridge(['answer', '1']);
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
      const input = await bridge(['paste-input']);
      if (normalized(input.value) !== normalized(prompt)) {
        await bridge(['clear-input']).catch(() => {});
        throw new Error('The prompt in the app input did not match what was pasted (was the app in use?); nothing was sent.');
      }
      // Marked first: a cancel that lands while Send is pressed must still stop the run.
      sent = true;
      try {
        await bridge(['send']);
      } catch (error) {
        if (error instanceof Cancelled) throw error;
        sent = false;
        await call(['clear-input']).catch(() => {});
        throw error;
      }
      await restore();
    }

    const deadline = Date.now() + timeoutToMilliseconds(options.timeout);
    const pollMs = Number(env.AGYBIRD_DESKTOP_POLL_MS) > 0 ? Number(env.AGYBIRD_DESKTOP_POLL_MS) : DEFAULT_POLL_MS;
    let state;
    for (;;) {
      await sleep(pollMs);
      state = await bridge(['snapshot']);
      if (state.dialog) {
        await cleanup();
        return emit(envelope({ status: 'needs_permission', category: options.category, requests: [permissionRequest(state.dialog)], warnings: [...warnings, 'The run is waiting in the Antigravity app for an answer to a permission prompt.'], evidence }));
      }
      if (!state.running && state.reply !== null) break;
      if (Date.now() >= deadline) {
        await call(['stop']).catch(() => warnings.push('Stop execution could not be pressed.'));
        throw new Error(`The run timed out after ${options.timeout} and was stopped in the app.`);
      }
    }

    // The accessibility text is rendered Markdown, split into words and without
    // code fences; the app's Copy button gives the reply as written.
    let response = state.reply;
    const clipboard = (await bridge(['clipboard-get'])).text;
    try {
      await bridge(['copy-reply']);
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
    const after = before && workTree(options.cwd);
    if (before && after) {
      evidence.changed_files = changedFiles(before, after);
      if (before.head !== after.head) warnings.push('HEAD moved during the run.');
      if (options.mode === 'read' && (evidence.changed_files.length > 0 || before.head !== after.head)) {
        status = 'error';
        warnings.push('The run changed the working tree in read mode.');
      }
    }
    await cleanup();
    emit(envelope({ status, category: options.category, response, structured, warnings, evidence }));
  } catch (caught) {
    let error = caught;
    if (cancelled) {
      if (sent) await call(['stop']).catch(() => warnings.push('Stop execution could not be pressed.'));
      error = new Error(sent ? 'The run was cancelled and stopped in the app.' : 'The run was cancelled before the prompt was sent.');
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
