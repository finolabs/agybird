#!/usr/bin/env node
// Stands in for `osascript -l JavaScript desktop-ax.js` in tests. Its scripted
// state lives in the JSON file named by AGYBIRD_FAKE_DESKTOP_STATE, and every
// call is appended to `calls` there.
//
// State keys: trusted, version, frontmost, preset, model, project, missingLabel,
// runningPolls (snapshots after send or answer that still show a run), stuck
// (never finishes once sent), lag (snapshots after send or answer before the run
// shows as running, with the earlier reply still on screen), dialog
// ({ question, options }), replyBeforeDialog (on screen while the dialog waits),
// reply, paste (what paste-input reads back instead of the clipboard), clipboard,
// clipboardMarkers (its org.nspasteboard.* types), clipboardOther (it also holds
// non-text content, which a restore loses),
// dialog.fragments (the question as separate text nodes), extraDialog (a second
// { question, options } dialog shown below the first),
// copyNoop (Copy leaves the clipboard as it was), title (the conversation title
// once sent), switchAfter (snapshots after which the app shows another
// conversation), untitledPolls (snapshots after send that still show the new
// conversation untitled; Send then returns no title), switchWhileUntitled (the
// app shows another conversation once those are over), titleBeforeSend (the
// title shown before send instead of the untitled new conversation),
// conversations (the names the sidebar lists before send; default
// ['Other Chat']), switchDuringNaming (the name of a listed conversation the
// user opens while the app is still naming the run's, during Send's wait),
// sendReturnsNoTitle (Send returns no title though the app titles it at once),
// failSnapshotAfterSend (every snapshot after send fails), stopFails (Stop
// execution cannot be pressed), onSend ({ path, content }: a file the "agent" writes when the
// prompt is sent), delays ({ command: ms }), exit (exit code), raw (printed
// instead of JSON), hang (never answers).

import { readFileSync, renameSync, writeFileSync } from 'node:fs';

import { loadAxDecisions } from '../../scripts/lib/desktop-bridge.mjs';

// The answer is decided by the shipped desktop-ax.js decisions, run on the
// node list this fake app would show.
const decisions = loadAxDecisions();
const LABELS = ['Message input', 'Select project', 'Select model', 'Agent permissions preset selector'];
const file = process.env.AGYBIRD_FAKE_DESKTOP_STATE;
const state = {
  trusted: true,
  version: '2.35.2',
  frontmost: 'com.example.host',
  preset: 'Request Review',
  model: 'Gemini 3.8 Flash Medium',
  project: 'workspace',
  runningPolls: 0,
  lag: 0,
  dialog: null,
  reply: 'done',
  clipboard: 'user clipboard',
  calls: [],
  ...JSON.parse(readFileSync(file, 'utf8')),
};
const [command, ...args] = process.argv.slice(2);
state.calls.push([command, ...args]);
// Atomic, so a test reading the state mid-run never sees half a file.
const save = () => {
  writeFileSync(`${file}.${process.pid}`, JSON.stringify(state));
  renameSync(`${file}.${process.pid}`, file);
};
save();

const delay = state.delays?.[command];
if (delay) await new Promise((done) => setTimeout(done, delay));

if (state.hang) setInterval(() => {}, 1_000);
else if (state.exit) {
  process.stderr.write('fake bridge failure\n');
  process.exit(state.exit);
} else if (state.raw !== undefined) process.stdout.write(`${state.raw}\n`);
else if (command === 'clipboard-set' || command === 'clipboard-restore') {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.concat(chunks).toString('utf8');
  if (command === 'clipboard-set') {
    state.clipboard = input;
    (state.clipboardWrites ??= []).push(state.clipboard);
  } else {
    // Only the text and its markers come back; anything else the clipboard held is gone.
    const saved = JSON.parse(input);
    state.clipboard = saved.text;
    state.restoredMarkers = saved.markers;
    state.clipboardOther = false;
  }
  process.stdout.write('{"ok":true}\n');
  save();
} else {
  process.stdout.write(`${JSON.stringify(answer())}\n`);
  save();
}

function title() {
  if (!state.sent) return state.titleBeforeSend ?? 'Antigravity';
  if (state.switched) return `${state.switchDuringNaming} - ${state.project} - Antigravity`;
  if (state.untitledLeft > 0 || state.namingLeft > 0) return 'Antigravity';
  if (state.switchWhileUntitled) return `Other Chat - ${state.project} - Antigravity`;
  if (state.switchAfter !== undefined && (state.polled ?? 0) > state.switchAfter) return `Other Chat - ${state.project} - Antigravity`;
  return state.title ?? `Fake Task - ${state.project} - Antigravity`;
}

// A turn starting after send or after an answer: lag, then running, then done.
function begin() {
  state.sent = true;
  state.lagLeft = state.lag;
}

function shown(expected) {
  return expected === undefined || expected === title();
}

// The conversations the sidebar lists: the existing ones and, once the app has
// titled it, the run's own.
function listed() {
  const own = (state.title ?? `Fake Task - ${state.project} - Antigravity`).split(' - ')[0];
  const titled = state.sent && !(state.untitledLeft > 0) && !(state.namingLeft > 0);
  return [...(state.conversations ?? ['Other Chat']), ...(titled ? [own] : [])];
}

// The accessibility nodes of the window: the sidebar, its titled web area and,
// while one waits, each dialog as the app renders it.
function screenNodes(withDialogs) {
  const nodes = [
    { depth: 0, role: 'AXWindow', label: 'Antigravity' },
    { depth: 1, role: 'AXWebArea', label: '' },
    { depth: 2, role: 'AXButton', label: state.project },
    { depth: 2, role: 'AXLink', label: 'New Conversation in Project' },
    ...listed().map((value) => ({ depth: 2, role: 'AXStaticText', label: '', value })),
    { depth: 1, role: 'AXWebArea', label: title() },
  ];
  if (!withDialogs) return nodes;
  for (const dialog of [state.dialog, state.extraDialog].filter(Boolean)) {
    nodes.push(
      { depth: 2, role: 'AXGroup', label: '' },
      ...(dialog.fragments ?? [dialog.question]).map((value) => ({ depth: 3, role: 'AXStaticText', label: '', value })),
      ...dialog.options.map((label) => ({ depth: 3, role: 'AXRadioButton', label })),
      { depth: 3, role: 'AXButton', label: 'Skip' },
      { depth: 3, role: 'AXButton', label: 'Submit' },
    );
  }
  return nodes;
}

function waiting() {
  return Boolean(state.dialog) && !state.answered;
}

function answer() {
  if (command === 'clipboard-get') return { text: state.clipboard, markers: state.clipboardMarkers ?? [], other: Boolean(state.clipboardOther) };
  if (command === 'probe') return { trusted: state.trusted, pid: 4242, version: state.version, frontmost: state.frontmost };
  if (!state.trusted) return { error: 'not_trusted' };
  switch (command) {
    case 'snapshot': {
      if (state.sent && state.failSnapshotAfterSend) return { error: 'snapshot_failed' };
      if (state.sent) state.polled = (state.polled ?? 0) + 1;
      // Read before the count drops, as the app shows it during this read.
      const shownTitle = title();
      if (state.untitledLeft > 0) state.untitledLeft -= 1;
      const lagging = Boolean(state.sent) && state.lagLeft > 0;
      if (lagging) state.lagLeft -= 1;
      const found = state.sent && !lagging && waiting() ? decisions.dialogs(screenNodes(true))[0] : null;
      const dialog = found ? { question: found.question, options: [...found.options] } : null;
      const running = Boolean(state.sent) && !lagging && !dialog && (state.stuck || state.runningPolls > 0);
      if (running && !state.stuck) state.runningPolls -= 1;
      let reply = null;
      if (lagging || dialog) reply = state.replyBeforeDialog ?? null;
      else if (state.sent && !running) reply = state.reply;
      return {
        labels: Object.fromEntries(LABELS.map((label) => [label, label !== state.missingLabel])),
        preset: running ? null : state.preset,
        model: state.model,
        project: state.project,
        title: shownTitle,
        running: running || Boolean(dialog),
        sendable: !running && !dialog,
        dialog,
        reply,
      };
    }
    case 'new-conversation':
      state.project = args[0];
      return { ok: true };
    case 'front':
      state.frontmost = 'com.google.antigravity';
      return { ok: true };
    case 'restore':
      state.frontmost = args[0];
      return { ok: true };
    case 'paste-input':
      if (!shown(args[0])) return { error: 'other_conversation' };
      return { ok: true, value: state.paste ?? state.clipboard };
    case 'clear-input':
      if (!shown(args[0])) return { error: 'other_conversation' };
      state.cleared = true;
      return { ok: true };
    case 'send': {
      const [expectedTitle, project] = args;
      if (!project) return { error: 'usage: send <expected title> <project>' };
      if (!shown(expectedTitle)) return { error: 'other_conversation' };
      const before = decisions.readable(screenNodes(false));
      begin();
      state.untitledLeft = state.untitledPolls ?? 0;
      // The user opens another conversation while the app is still naming the run's.
      state.namingLeft = state.switchDuringNaming ? 1 : 0;
      if (state.onSend) writeFileSync(state.onSend.path, state.onSend.content);
      if (state.sendReturnsNoTitle) return { ok: true, title: null };
      // The naming interval, read a few times as desktop-ax.js send reads it.
      for (let read = 0; read < 5; read += 1) {
        const named = decisions.namedConversation(before, screenNodes(false), expectedTitle, project);
        if (named?.title) return { ok: true, title: named.title };
        if (named?.refused) return { ok: true, title: null, refused: named.refused };
        if (state.namingLeft > 0) {
          state.namingLeft -= 1;
          state.switched = true;
        }
      }
      return { ok: true, title: null };
    }
    case 'answer': {
      const [option, question, expectedTitle] = args;
      try {
        decisions.chooseAnswer(screenNodes(waiting()), option, question, expectedTitle);
      } catch (error) {
        return { error: error.message };
      }
      state.answered = option;
      if (option === '1') begin();
      return { ok: true };
    }
    case 'copy-reply':
      if (!state.sent) return { error: 'not_found: Response actions' };
      if (!shown(args[0])) return { error: 'other_conversation' };
      if (state.copyNoop) return { error: 'copy_unchanged' };
      state.clipboard = state.reply;
      return { ok: true, text: state.reply };
    case 'stop':
      if (!shown(args[0])) return { error: 'other_conversation' };
      if (state.stopFails) return { error: 'press_failed: Stop execution' };
      state.stuck = false;
      state.runningPolls = 0;
      state.stopped = true;
      return { ok: true };
    default:
      return { error: `unknown command: ${command}` };
  }
}
