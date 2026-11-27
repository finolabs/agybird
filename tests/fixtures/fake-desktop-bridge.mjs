#!/usr/bin/env node
// Stands in for `osascript -l JavaScript desktop-ax.js` in tests. Its scripted
// state lives in the JSON file named by AGYBIRD_FAKE_DESKTOP_STATE, and every
// call is appended to `calls` there.
//
// State keys: trusted, version, frontmost, preset, model, project, missingLabel,
// runningPolls (snapshots after send that still show a run), stuck (never
// finishes once sent),
// dialog ({ question, options }), reply, paste (what paste-input reads back
// instead of the clipboard), clipboard, onSend ({ path, content }: a file the
// "agent" writes when the prompt is sent), exit (exit code), raw (printed
// instead of JSON), hang (never answers).

import { readFileSync, renameSync, writeFileSync } from 'node:fs';

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
      const running = Boolean(state.sent) && (state.stuck || state.runningPolls > 0);
      if (running && !state.stuck) state.runningPolls -= 1;
      const dialog = state.sent && state.dialog && !state.answered ? state.dialog : null;
      return {
        labels: Object.fromEntries(LABELS.map((label) => [label, label !== state.missingLabel])),
        preset: running ? null : state.preset,
        model: state.model,
        project: state.project,
        running: running || Boolean(dialog),
        sendable: !running && !dialog,
        dialog,
        reply: !state.sent || running || dialog ? null : state.reply,
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
      state.sent = true;
      if (state.onSend) writeFileSync(state.onSend.path, state.onSend.content);
      return { ok: true };
    case 'answer':
      if (!['1', 'Skip'].includes(args[0])) return { error: 'refused: only 1 or Skip may be answered' };
      if (!state.dialog || state.answered) return { error: 'not_found: permission dialog' };
      state.answered = args[0];
      return { ok: true };
    case 'copy-reply':
      if (!state.sent) return { error: 'not_found: Response actions' };
      state.clipboard = state.reply;
      return { ok: true };
    case 'stop':
      state.stuck = false;
      state.runningPolls = 0;
      state.stopped = true;
      return { ok: true };
    default:
      return { error: `unknown command: ${command}` };
  }
}
