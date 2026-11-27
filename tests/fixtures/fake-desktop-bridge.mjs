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
// copyNoop (Copy leaves the clipboard as it was), title (the conversation title
// once sent), switchAfter (snapshots after which the app shows another
// conversation), onSend ({ path, content }: a file the "agent" writes when the
// prompt is sent), delays ({ command: ms }), exit (exit code), raw (printed
// instead of JSON), hang (never answers).

import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const LABELS = ['Message input', 'Select project', 'Select model', 'Agent permissions preset selector'];
const OPTION_1 = '1 Yes, allow this time';
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
else if (command === 'clipboard-set' && args[0] !== '--empty') {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  state.clipboard = Buffer.concat(chunks).toString('utf8');
  (state.clipboardWrites ??= []).push(state.clipboard);
  process.stdout.write('{"ok":true}\n');
  save();
} else {
  process.stdout.write(`${JSON.stringify(answer())}\n`);
  save();
}

function title() {
  if (!state.sent) return 'Antigravity';
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

function answer() {
  if (command === 'clipboard-get') return { text: state.clipboard };
  if (command === 'clipboard-set') {
    state.clipboard = null;
    return { ok: true };
  }
  if (command === 'probe') return { trusted: state.trusted, pid: 4242, version: state.version, frontmost: state.frontmost };
  if (!state.trusted) return { error: 'not_trusted' };
  switch (command) {
    case 'snapshot': {
      if (state.sent) state.polled = (state.polled ?? 0) + 1;
      const lagging = Boolean(state.sent) && state.lagLeft > 0;
      if (lagging) state.lagLeft -= 1;
      const dialog = state.sent && !lagging && state.dialog && !state.answered ? state.dialog : null;
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
        title: title(),
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
      return { ok: true, value: state.paste ?? state.clipboard };
    case 'clear-input':
      return { ok: true };
    case 'send':
      begin();
      if (state.onSend) writeFileSync(state.onSend.path, state.onSend.content);
      return { ok: true };
    case 'answer': {
      const [option, question, expectedTitle] = args;
      if (!['1', 'Skip'].includes(option)) return { error: 'refused: only 1 or Skip may be answered' };
      if (!state.dialog || state.answered) return { error: 'not_found: permission dialog' };
      if (!shown(expectedTitle)) return { error: 'other_conversation' };
      if (option === '1') {
        if (question !== state.dialog.question) return { error: 'question_changed' };
        if (state.dialog.options[0] !== OPTION_1) return { error: 'not_found: option 1' };
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
      return { ok: true };
    case 'stop':
      if (!shown(args[0])) return { error: 'other_conversation' };
      state.stuck = false;
      state.runningPolls = 0;
      state.stopped = true;
      return { ok: true };
    default:
      return { error: `unknown command: ${command}` };
  }
}
