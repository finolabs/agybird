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
// earlier ({ title, running, message }: the conversation of an earlier run on
// screen until a new conversation opens),
// message (the user's message the run's conversation shows; Send sets it to
// the pasted prompt, so a resumed run's state names it), namesakeAfter
// (snapshots after which the app shows another conversation under the run's
// own title), rivalDuringNaming (the name of a new conversation the user
// creates and the app titles during Send's wait, shown from then on),
// conversations (the names the sidebar lists before send; default
// ['Other Chat']), switchDuringNaming (the name of a listed conversation the
// user opens while the app is still naming the run's, during Send's wait),
// sendReturnsNoTitle (Send returns no title though the app titles it at once),
// failSnapshotAfterSend (every snapshot after send fails), stopFails (Stop
// execution cannot be pressed), answerThenCrash (the answer is pressed, then
// the bridge exits with an error), secondPaneIn (the commands during which,
// once sent, a second conversation window shows the same dialog, reply, Copy
// and Stop), secondComposerIn (the commands during which an untitled pane, an
// unlabelled web area before the run's conversation, holds its own Message
// input and Send message; what reaches it is recorded as rivalComposer,
// rivalCleared and rivalSent), onSend ({ path, content }: a file the "agent" writes when the
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
  if (!state.sent && state.earlier) return state.earlier.title;
  if (!state.sent) return state.titleBeforeSend ?? 'Antigravity';
  if (state.rivalDuringNaming) return `${state.rivalDuringNaming} - ${state.project} - Antigravity`;
  if (state.switched) return `${state.switchDuringNaming} - ${state.project} - Antigravity`;
  if (state.untitledLeft > 0 || state.namingLeft > 0) return 'Antigravity';
  if (state.switchWhileUntitled) return `Other Chat - ${state.project} - Antigravity`;
  if (state.switchAfter !== undefined && (state.polled ?? 0) > state.switchAfter) return `Other Chat - ${state.project} - Antigravity`;
  return state.title ?? `Fake Task - ${state.project} - Antigravity`;
}

// The user's message the conversation on screen shows, as title() picks that
// conversation: the run's own is the prompt it pasted (or `message`).
function conversationText() {
  const ANOTHER = 'Another task of the user.';
  if (!state.sent && state.earlier) return state.earlier.message ?? '';
  if (!state.sent) return '';
  if (state.rivalDuringNaming || state.switched) return ANOTHER;
  if (state.untitledLeft > 0 || state.namingLeft > 0) return state.message ?? '';
  if (state.switchWhileUntitled) return ANOTHER;
  if (state.switchAfter !== undefined && (state.polled ?? 0) > state.switchAfter) return ANOTHER;
  if (state.namesakeAfter !== undefined && (state.polled ?? 0) > state.namesakeAfter) return ANOTHER;
  return state.message ?? '';
}

// A turn starting after send or after an answer: lag, then running, then done.
function begin() {
  state.sent = true;
  state.lagLeft = state.lag;
}

// The conversations the sidebar lists: the existing ones and, once the app has
// titled it, the run's own.
function listed() {
  const own = (state.title ?? `Fake Task - ${state.project} - Antigravity`).split(' - ')[0];
  const titled = state.sent && !(state.untitledLeft > 0) && !(state.namingLeft > 0);
  const rival = state.sent && state.rivalDuringNaming ? [state.rivalDuringNaming] : [];
  return [...(state.conversations ?? ['Other Chat']), ...rival, ...(titled ? [own] : [])];
}

// A conversation's controls once sent: the reply with its response actions
// (Copy) and Stop execution.
function controls() {
  if (!state.sent) return [];
  return [
    { depth: 2, role: 'AXHeading', label: 'Agent said' },
    { depth: 2, role: 'AXGroup', label: '' },
    { depth: 3, role: 'AXStaticText', label: '', value: String(state.reply ?? '') },
    { depth: 2, role: 'AXGroup', label: 'Response actions' },
    { depth: 3, role: 'AXButton', label: 'Copy' },
    { depth: 2, role: 'AXButton', label: 'Stop execution' },
  ];
}

function dialogNodes(withDialogs) {
  if (!withDialogs) return [];
  return [state.dialog, state.extraDialog].filter(Boolean).flatMap((dialog) => [
    { depth: 2, role: 'AXGroup', label: '' },
    ...(dialog.fragments ?? [dialog.question]).map((value) => ({ depth: 3, role: 'AXStaticText', label: '', value })),
    ...dialog.options.map((label) => ({ depth: 3, role: 'AXRadioButton', label })),
    { depth: 3, role: 'AXButton', label: 'Skip' },
    { depth: 3, role: 'AXButton', label: 'Submit' },
  ]);
}

// The composer and Send of a conversation pane; `rival` marks a second pane's.
function composer(rival) {
  return [
    { depth: 2, role: 'AXTextArea', label: 'Message input', ...(rival ? { rival } : {}) },
    { depth: 2, role: 'AXButton', label: 'Send message', ...(rival ? { rival } : {}) },
  ];
}

// The accessibility nodes of the window: the sidebar, its titled web area with
// the user's message, one text node per line, the conversation's controls,
// while one waits each dialog as the app renders it, then its composer. During the commands
// `secondPaneIn` names, once sent, a second conversation window shows the
// same dialog and controls.
function screenNodes(withDialogs) {
  const text = conversationText();
  const nodes = [
    { depth: 0, role: 'AXWindow', label: 'Antigravity' },
    { depth: 1, role: 'AXWebArea', label: '' },
    { depth: 2, role: 'AXButton', label: state.project },
    { depth: 2, role: 'AXLink', label: 'New Conversation in Project' },
    ...listed().map((value) => ({ depth: 2, role: 'AXStaticText', label: '', value })),
    { depth: 1, role: 'AXWebArea', label: title() },
    ...(text ? [{ depth: 2, role: 'AXGroup', label: '' }, ...text.split('\n').map((value) => ({ depth: 3, role: 'AXStaticText', label: '', value }))] : []),
    ...controls(),
    ...dialogNodes(withDialogs),
    ...composer(false),
  ];
  if (state.secondComposerIn?.includes(command)) {
    nodes.unshift({ depth: 0, role: 'AXWindow', label: 'Antigravity' }, { depth: 1, role: 'AXWebArea', label: '' }, ...composer(true));
  }
  if (state.sent && state.secondPaneIn?.includes(command)) {
    nodes.push(
      { depth: 0, role: 'AXWindow', label: 'Antigravity' },
      { depth: 1, role: 'AXWebArea', label: `Second Chat - ${state.project} - Antigravity` },
      { depth: 2, role: 'AXGroup', label: '' },
      { depth: 3, role: 'AXStaticText', label: '', value: 'Another task of the user.' },
      ...controls(),
      ...dialogNodes(withDialogs),
    );
  }
  return nodes;
}

// The composer or Send the shipped decision picks in the window, or an error.
function pick(expected, control) {
  try {
    const nodes = screenNodes(false);
    const index = decisions.chooseComposer(nodes, expected, control);
    return index < 0 ? { error: `not_found: ${control}` } : { node: nodes[index] };
  } catch (error) {
    return { error: error.message };
  }
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
      let own;
      try {
        if (args[0] !== undefined) own = decisions.ownConversation(screenNodes(false), args[0]);
        // As desktop-ax.js reads them: only inside the one titled conversation.
        decisions.running(screenNodes(true));
        decisions.reply(screenNodes(true));
        decisions.dialogs(screenNodes(true));
      } catch (error) {
        return { error: error.message };
      }
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
        running: running || Boolean(dialog) || Boolean(!state.sent && state.earlier?.running),
        sendable: !running && !dialog,
        dialog,
        reply,
        ...(own === undefined ? {} : { own }),
      };
    }
    case 'new-conversation':
      state.project = args[0];
      delete state.earlier;
      return { ok: true };
    case 'front':
      state.frontmost = 'com.google.antigravity';
      return { ok: true };
    case 'restore':
      state.frontmost = args[0];
      return { ok: true };
    case 'paste-input': {
      const input = pick(args[0], 'Message input');
      if (input.error) return { error: input.error };
      const value = state.paste ?? state.clipboard;
      if (input.node.rival) state.rivalComposer = value;
      else state.composer = value;
      return { ok: true, value };
    }
    case 'clear-input': {
      const input = pick(args[0], 'Message input');
      if (input.error) return { error: input.error };
      if (input.node.rival) state.rivalCleared = true;
      else state.cleared = true;
      return { ok: true };
    }
    case 'send': {
      const [expectedTitle, project, nonce] = args;
      if (!project) return { error: 'usage: send <expected title> <project> <run marker>' };
      try {
        decisions.marker(nonce);
      } catch (error) {
        return { error: error.message };
      }
      const button = pick(expectedTitle, 'Send message');
      if (button.error) return { error: button.error };
      if (button.node.rival) {
        state.rivalSent = state.rivalComposer ?? '';
        return { ok: true, title: null };
      }
      // The composer's text becomes the conversation's message.
      state.message = state.composer;
      begin();
      state.untitledLeft = state.untitledPolls ?? 0;
      // The user opens another conversation while the app is still naming the run's.
      state.namingLeft = state.switchDuringNaming ? 1 : 0;
      if (state.onSend) writeFileSync(state.onSend.path, state.onSend.content);
      if (state.sendReturnsNoTitle) return { ok: true, title: null };
      // The naming interval, read a few times as desktop-ax.js send reads it.
      let seen = null;
      for (let read = 0; read < 5; read += 1) {
        const named = decisions.namedConversation(screenNodes(false), expectedTitle, project, nonce);
        if (named?.title) return { ok: true, title: named.title };
        if (named?.refused) return { ok: true, title: null, refused: named.refused };
        if (title() !== expectedTitle) seen = title();
        if (state.namingLeft > 0) {
          state.namingLeft -= 1;
          state.switched = true;
        }
      }
      return seen ? { ok: true, title: null, refused: seen } : { ok: true, title: null };
    }
    case 'answer': {
      const [option, question, expectedTitle, nonce] = args;
      try {
        decisions.chooseAnswer(screenNodes(waiting()), option, question, expectedTitle, nonce);
      } catch (error) {
        return { error: error.message };
      }
      state.answered = option;
      if (option === '1') begin();
      if (state.answerThenCrash) {
        save();
        process.stderr.write('fake bridge crashed after the press\n');
        process.exit(1);
      }
      return { ok: true };
    }
    case 'copy-reply':
      if (!state.sent) return { error: 'not_found: Response actions' };
      try {
        decisions.chooseCopy(screenNodes(false), args[0], args[1]);
      } catch (error) {
        return { error: error.message };
      }
      if (state.copyNoop) return { error: 'copy_unchanged' };
      state.clipboard = state.reply;
      return { ok: true, text: state.reply };
    case 'stop':
      try {
        decisions.chooseStop(screenNodes(false), args[0], args[1]);
      } catch (error) {
        return { error: error.message };
      }
      if (state.stopFails) return { error: 'press_failed: Stop execution' };
      state.stuck = false;
      state.runningPolls = 0;
      state.stopped = true;
      return { ok: true };
    default:
      return { error: `unknown command: ${command}` };
  }
}
