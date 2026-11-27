#!/usr/bin/env node
// Stands in for `osascript -l JavaScript desktop-ax.js` in tests. Its scripted
// state lives in the JSON file named by AGYBIRD_FAKE_DESKTOP_STATE, and every
// call is appended to `calls` there.
//
// State keys: trusted, version, frontmost, preset, model, project, missingLabel,
// runningPolls (snapshots that still show a run), stuck (never finishes),
// dialog ({ question, options }), reply, paste (what paste-input reads back),
// exit (exit code), raw (printed instead of JSON), hang (never answers).

import { readFileSync, writeFileSync } from 'node:fs';

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
  paste: '',
  calls: [],
  ...JSON.parse(readFileSync(file, 'utf8')),
};
const [command, ...args] = process.argv.slice(2);
state.calls.push([command, ...args]);
const save = () => writeFileSync(file, JSON.stringify(state));
save();

if (state.hang) setInterval(() => {}, 1_000);
else if (state.exit) {
  process.stderr.write('fake bridge failure\n');
  process.exit(state.exit);
} else if (state.raw !== undefined) process.stdout.write(`${state.raw}\n`);
else {
  process.stdout.write(`${JSON.stringify(answer())}\n`);
  save();
}

function answer() {
  if (command === 'probe') return { trusted: state.trusted, pid: 4242, version: state.version, frontmost: state.frontmost };
  if (!state.trusted) return { error: 'not_trusted' };
  switch (command) {
    case 'snapshot': {
      const running = state.stuck || state.runningPolls > 0;
      if (!state.stuck && state.runningPolls > 0) state.runningPolls -= 1;
      const dialog = state.dialog && !state.answered ? state.dialog : null;
      return {
        labels: Object.fromEntries(LABELS.map((label) => [label, label !== state.missingLabel])),
        preset: running ? null : state.preset,
        model: state.model,
        project: state.project,
        running: running || Boolean(dialog),
        sendable: !running && !dialog,
        dialog,
        reply: running || dialog ? null : state.reply,
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
      return { ok: true, value: state.paste };
    case 'clear-input':
    case 'send':
      return { ok: true };
    case 'answer':
      if (!['1', 'Skip'].includes(args[0])) return { error: 'refused: only 1 or Skip may be answered' };
      if (!state.dialog || state.answered) return { error: 'not_found: permission dialog' };
      state.answered = args[0];
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
