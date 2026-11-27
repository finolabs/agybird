// Drives the Antigravity desktop app through the macOS Accessibility API.
// Run by `osascript -l JavaScript desktop-ax.js <command> [args]`; prints one
// JSON line. It sends no keystrokes: every action is an AX attribute, an AX
// action, or one of the app's own menu items. Of a permission dialog it presses
// only option 1 ("allow this time") or Skip.

ObjC.import('AppKit');
ObjC.bindFunction('AXUIElementCreateApplication', ['id', ['int']]);
ObjC.bindFunction('AXUIElementCopyAttributeValue', ['int', ['id', 'id', 'id*']]);
ObjC.bindFunction('AXUIElementSetAttributeValue', ['int', ['id', 'id', 'id']]);
ObjC.bindFunction('AXUIElementPerformAction', ['int', ['id', 'id']]);
ObjC.bindFunction('AXIsProcessTrusted', ['bool', []]);

const BUNDLE_ID = 'com.google.antigravity';
const MAX_NODES = 20000;
const REQUIRED_LABELS = ['Message input', 'Select project', 'Select model', 'Agent permissions preset selector'];

// desktop-decisions:start
// Pure decisions over the flat node list a tree walk returns: { role, label,
// depth } plus `value` where a test recorded one. Nothing here calls the
// accessibility API, so desktop-bridge.mjs loadAxDecisions() evaluates this
// region alone and the unit tests run it on recorded node lists. osascript
// loads this one file, so the region stays inside it rather than in a module
// JXA could not import.
const UNTITLED = 'Antigravity';
const ANSWERS = ['1', 'Skip'];
const OPTION_1 = '1 Yes, allow this time';
// Controls whose text is their own label, not part of what a dialog asks.
const CONTROLS = ['AXRadioButton', 'AXButton', 'AXCheckBox', 'AXPopUpButton', 'AXTextArea', 'AXTextField'];

function readNode(node) {
  return node.value || node.label || '';
}

// The runner matches the whole question, flattened as it stores it, with no cap.
function flatten(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// The index just past the subtree of nodes[index] in a depth-first list.
function subtreeEnd(nodes, index) {
  let end = index + 1;
  while (end < nodes.length && nodes[end].depth > nodes[index].depth) end += 1;
  return end;
}

function parentOf(nodes, index) {
  for (let parent = index - 1; parent >= 0; parent -= 1) if (nodes[parent].depth < nodes[index].depth) return parent;
  return -1;
}

const isOption1 = (node) => node.role === 'AXRadioButton' && /^1 /.test(node.label);
const isButton = (node, prefix) => node.role === 'AXButton' && node.label.startsWith(prefix);

// The conversation on screen, as the web area's title: "<title> - <project> -
// Antigravity", or "Antigravity" before a new conversation has been sent.
// The window holds an untitled web area beside the titled one.
function title(nodes) {
  const area = nodes.find((node) => node.role === 'AXWebArea' && node.label);
  return area ? area.label : null;
}

// Every permission dialog on screen. A dialog is the smallest group that holds
// an option 1 radio and a Skip button. Its question is every static text inside
// that group, in order, outside the options, buttons and inputs: rendered
// Markdown splits a question into word and code-span nodes. Its options, Skip
// and Submit are found inside the same group only. A group holding two option
// 1 radios is marked ambiguous.
function dialogs(nodes, read) {
  const textOf = read || readNode;
  const found = [];
  const groups = [];
  nodes.forEach((node, index) => {
    if (!isOption1(node)) return;
    for (let group = parentOf(nodes, index); group >= 0; group = parentOf(nodes, group)) {
      const end = subtreeEnd(nodes, group);
      const inside = (test) => {
        for (let at = group + 1; at < end; at += 1) if (test(nodes[at])) return at;
        return -1;
      };
      const skip = inside((entry) => isButton(entry, 'Skip'));
      if (skip < 0) continue;
      if (groups.indexOf(group) >= 0) return;
      groups.push(group);
      const parts = [];
      const options = [];
      let option1 = -1;
      let firsts = 0;
      for (let at = group + 1; at < end; at += 1) {
        const entry = nodes[at];
        if (isOption1(entry)) {
          firsts += 1;
          if (option1 < 0) option1 = at;
        }
        if (entry.role === 'AXRadioButton' && /^\d /.test(entry.label)) options.push(entry.label);
        if (CONTROLS.indexOf(entry.role) >= 0) {
          at = subtreeEnd(nodes, at) - 1;
        } else if (entry.role === 'AXStaticText') {
          parts.push(String(textOf(entry)));
        }
      }
      found.push({ question: flatten(parts.join(' ')), options, option1, skip, submit: inside((entry) => isButton(entry, 'Submit')), ambiguous: firsts > 1 });
      return;
    }
  });
  return found;
}

// The nodes to press, in order, to answer the dialog that asks `question`, the
// whole flattened question, in the conversation titled `expected`. Any mismatch
// throws and nothing is pressed.
function chooseAnswer(nodes, option, question, expected, read) {
  if (ANSWERS.indexOf(option) < 0) throw new Error('refused: only 1 or Skip may be answered');
  if (!question || !expected) throw new Error('usage: answer <1|Skip> <question> <conversation title>');
  const shown = dialogs(nodes, read);
  if (shown.length === 0) throw new Error('not_found: permission dialog');
  if (title(nodes) !== expected) throw new Error('other_conversation');
  const asking = shown.filter((prompt) => prompt.question === question);
  if (asking.length === 0) throw new Error('question_changed');
  if (asking.length > 1 || asking[0].ambiguous) throw new Error('several_dialogs');
  const prompt = asking[0];
  if (option === 'Skip') return [{ index: prompt.skip, what: 'Skip' }];
  if (nodes[prompt.option1].label.trim() !== OPTION_1) throw new Error('not_found: option 1');
  if (prompt.submit < 0) throw new Error('not_found: Submit');
  return [{ index: prompt.option1, what: 'option 1' }, { index: prompt.submit, what: 'Submit' }];
}
// desktop-decisions:end

function get(element, name) {
  const value = Ref();
  return $.AXUIElementCopyAttributeValue(element, $(name), value) === 0 ? value[0] : null;
}

function text(value) {
  if (!value) return '';
  try {
    const js = value.js;
    return typeof js === 'string' ? js : '';
  } catch (error) {
    return '';
  }
}

function children(element) {
  const list = get(element, 'AXChildren');
  const out = [];
  if (list) for (let index = 0; index < list.count; index += 1) out.push(list.objectAtIndex(index));
  return out;
}

function walk(element, nodes, depth = 0) {
  if (nodes.length >= MAX_NODES) return nodes;
  const node = { role: text(get(element, 'AXRole')), label: text(get(element, 'AXDescription')) || text(get(element, 'AXTitle')), depth, element };
  nodes.push(node);
  // The composer holds one node per line of a pasted prompt; only paste-input reads them.
  if (node.role === 'AXTextArea' && node.label === 'Message input') return nodes;
  for (const child of children(element)) walk(child, nodes, depth + 1);
  return nodes;
}

// AXValue of the composer is cut after a few thousand characters, so its text
// is read from the line nodes inside it.
function inputText(input) {
  const lines = [];
  const visit = (element) => {
    for (const child of children(element)) {
      if (text(get(child, 'AXRole')) === 'AXStaticText') lines.push(text(get(child, 'AXValue')));
      visit(child);
    }
  };
  visit(input.element);
  return lines.length ? lines.join('\n') : text(get(input.element, 'AXValue'));
}

function runningApp() {
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(BUNDLE_ID);
  return apps.count ? apps.objectAtIndex(0) : null;
}

function application() {
  const app = runningApp();
  if (!app) throw new Error('app_not_running');
  const element = $.AXUIElementCreateApplication(app.processIdentifier);
  $.AXUIElementSetAttributeValue(element, $('AXManualAccessibility'), $.NSNumber.numberWithBool(true));
  return element;
}

function tree(app) {
  // An empty walk right after AXManualAccessibility is set is retried once.
  let nodes = walk(app, []);
  if (nodes.length < 50) nodes = walk(app, []);
  return nodes;
}

function find(nodes, role, prefix) {
  return nodes.find((node) => node.role === role && node.label.startsWith(prefix)) || null;
}

function press(node, what) {
  if (!node) throw new Error(`not_found: ${what}`);
  if ($.AXUIElementPerformAction(node.element, $('AXPress')) !== 0) throw new Error(`press_failed: ${what}`);
}

function current(nodes, prefix) {
  const node = find(nodes, 'AXPopUpButton', `${prefix}, current: `);
  return node ? node.label.slice(`${prefix}, current: `.length) : null;
}

function staticText(node) {
  return text(get(node.element, 'AXValue')) || node.label;
}

// The reply is the group right after the last `Agent said` heading, at the
// heading's own depth; the response actions that follow are a separate group.
function reply(nodes) {
  let heading = -1;
  nodes.forEach((node, index) => {
    if (node.role === 'AXHeading' && node.label === 'Agent said') heading = index;
  });
  if (heading < 0) return null;
  const depth = nodes[heading].depth;
  const start = nodes.findIndex((node, index) => index > heading && node.depth <= depth);
  if (start < 0 || nodes[start].depth < depth || nodes[start].role !== 'AXGroup') return null;
  const lines = [];
  for (let index = start + 1; index < nodes.length && nodes[index].depth > depth; index += 1) {
    if (nodes[index].role === 'AXStaticText') lines.push(staticText(nodes[index]));
  }
  return lines.join('\n');
}

function requireTitle(nodes, expected) {
  if (!expected) throw new Error('usage: the expected conversation title is required');
  if (title(nodes) !== expected) throw new Error('other_conversation');
}

// The tree, once a read shows the expected conversation; a read with no title
// at all (the web areas re-rendering) is retried a few times.
function showing(app, expected) {
  for (let tries = 0; tries < 5; tries += 1) {
    if (tries > 0) delay(0.2);
    const nodes = tree(app);
    if (title(nodes) !== null) {
      requireTitle(nodes, expected);
      return nodes;
    }
  }
  throw new Error('other_conversation');
}

// How long Send waits for the app to title the new conversation.
const TITLE_WAIT_MS = 30000;

function snapshot(nodes) {
  const labels = {};
  for (const label of REQUIRED_LABELS) labels[label] = nodes.some((node) => node.label.startsWith(label));
  return {
    labels,
    preset: current(nodes, 'Agent permissions preset selector'),
    model: current(nodes, 'Select model'),
    project: current(nodes, 'Select project'),
    title: title(nodes),
    running: Boolean(find(nodes, 'AXButton', 'Stop execution')),
    sendable: Boolean(find(nodes, 'AXButton', 'Send message')),
    dialog: dialogs(nodes, staticText).map((prompt) => ({ question: prompt.question, options: prompt.options }))[0] || null,
    reply: reply(nodes),
  };
}

function menu(app, top, item) {
  for (const bar of children(get(app, 'AXMenuBar'))) {
    if (text(get(bar, 'AXTitle')) !== top) continue;
    for (const list of children(bar)) {
      for (const entry of children(list)) {
        if (text(get(entry, 'AXTitle')) === item) return press({ element: entry }, `${top} > ${item}`);
      }
    }
  }
  throw new Error(`not_found: ${top} > ${item}`);
}

function isFrontmost() {
  const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return Boolean(front) && text(front.bundleIdentifier) === BUNDLE_ID;
}

function focusInput(app, expected) {
  const input = find(showing(app, expected), 'AXTextArea', 'Message input');
  if (!input) throw new Error('not_found: Message input');
  if (!isFrontmost()) throw new Error('not_frontmost');
  $.AXUIElementSetAttributeValue(input.element, $('AXFocused'), $.NSNumber.numberWithBool(true));
  return input;
}

function readStdin() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  return $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
}

// Only the plain-text flavour is saved and put back.
const CLIPBOARD = {
  'clipboard-get'() {
    const value = $.NSPasteboard.generalPasteboard.stringForType($.NSPasteboardTypeString);
    return { text: value && !value.isNil() ? value.js : null };
  },
  'clipboard-set'(empty) {
    const board = $.NSPasteboard.generalPasteboard;
    board.clearContents;
    if (empty !== '--empty') board.setStringForType($(readStdin()), $.NSPasteboardTypeString);
    return { ok: true };
  },
};

const COMMANDS = {
  ...CLIPBOARD,
  probe() {
    const app = runningApp();
    const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    const info = app ? $.NSBundle.bundleWithURL(app.bundleURL) : null;
    return {
      trusted: $.AXIsProcessTrusted(),
      pid: app ? app.processIdentifier : null,
      version: info ? text(info.objectForInfoDictionaryKey('CFBundleShortVersionString')) : null,
      frontmost: front ? text(front.bundleIdentifier) : null,
    };
  },
  snapshot(app) {
    return snapshot(tree(app));
  },
  'new-conversation'(app, project) {
    if (!project) throw new Error('usage: new-conversation <project>');
    const nodes = tree(app);
    const start = nodes.findIndex((node) => node.role === 'AXButton' && node.label === project);
    if (start < 0) throw new Error(`not_found: project ${project}`);
    // Each project's own link follows its name button in the sidebar.
    press(nodes.slice(start + 1).find((node) => node.role === 'AXLink' && node.label === 'New Conversation in Project'), 'New Conversation in Project');
    return { ok: true };
  },
  front(app) {
    $.AXUIElementSetAttributeValue(app, $('AXFrontmost'), $.NSNumber.numberWithBool(true));
    delay(0.3);
    return { ok: isFrontmost() };
  },
  restore(app, bundleId) {
    if (!/^[A-Za-z0-9.-]+$/.test(bundleId || '')) throw new Error('usage: restore <bundle id>');
    const shell = Application.currentApplication();
    shell.includeStandardAdditions = true;
    // Only an app still running is brought back; open -b would relaunch one the user quit.
    if (!$.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundleId).count) return { ok: false };
    shell.doShellScript(`/usr/bin/open -b ${bundleId}`);
    delay(0.3);
    const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    return { ok: Boolean(front) && text(front.bundleIdentifier) === bundleId };
  },
  'paste-input'(app, expectedTitle) {
    const input = focusInput(app, expectedTitle);
    menu(app, 'Edit', 'Paste');
    // The paste lands asynchronously: read until the text is non-blank and steady.
    let value = '';
    for (let tries = 0; tries < 30; tries += 1) {
      delay(0.2);
      const next = inputText(input);
      if (next.trim() && next === value) break;
      value = next;
    }
    return { ok: true, value };
  },
  'clear-input'(app, expectedTitle) {
    focusInput(app, expectedTitle);
    menu(app, 'Edit', 'Select All');
    menu(app, 'Edit', 'Delete');
    return { ok: true };
  },
  // Presses Send only while the expected (untitled new) conversation shows, then
  // returns the title the app gives it, read in this same call: that title is
  // the run's conversation from then on. No title within the wait returns null.
  send(app, expectedTitle) {
    // The button appears only once the input holds text, which can lag the paste.
    let button = null;
    for (let tries = 0; tries < 10 && !button; tries += 1) {
      if (tries > 0) delay(0.2);
      button = find(showing(app, expectedTitle), 'AXButton', 'Send message');
    }
    press(button, 'Send message');
    const until = Date.now() + TITLE_WAIT_MS;
    while (Date.now() < until) {
      delay(0.25);
      const now = title(tree(app));
      if (now && now !== expectedTitle) return { ok: true, title: now };
    }
    return { ok: true, title: null };
  },
  // An answer is pressed only in the same tree read that shows the expected
  // conversation, the approved question and, for option 1, its exact label.
  answer(app, option, question, expectedTitle) {
    if (!ANSWERS.includes(option)) throw new Error('refused: only 1 or Skip may be answered');
    const nodes = tree(app);
    for (const target of chooseAnswer(nodes, option, question, expectedTitle, staticText)) press(nodes[target.index], target.what);
    return { ok: true };
  },
  // Puts the last reply, as the app's own Markdown, on the clipboard.
  'copy-reply'(app, expectedTitle) {
    const nodes = tree(app);
    requireTitle(nodes, expectedTitle);
    let group = -1;
    nodes.forEach((node, index) => {
      if (node.role === 'AXGroup' && node.label === 'Response actions') group = index;
    });
    if (group < 0) throw new Error('not_found: Response actions');
    const depth = nodes[group].depth;
    let button = null;
    for (let index = group + 1; index < nodes.length && nodes[index].depth > depth && !button; index += 1) {
      if (nodes[index].role === 'AXButton' && nodes[index].label === 'Copy') button = nodes[index];
    }
    // The copy lands asynchronously; an unchanged pasteboard means it did not.
    const board = $.NSPasteboard.generalPasteboard;
    const before = board.changeCount;
    press(button, 'Copy');
    for (let tries = 0; tries < 20 && board.changeCount === before; tries += 1) delay(0.1);
    if (board.changeCount === before) throw new Error('copy_unchanged');
    return { ok: true };
  },
  stop(app, expectedTitle) {
    const nodes = tree(app);
    requireTitle(nodes, expectedTitle);
    press(find(nodes, 'AXButton', 'Stop execution'), 'Stop execution');
    return { ok: true };
  },
};

function run(argv) {
  const [command, ...args] = argv;
  try {
    if (!Object.prototype.hasOwnProperty.call(COMMANDS, command)) throw new Error(`unknown command: ${command}`);
    if (command === 'probe' || command in CLIPBOARD) return JSON.stringify(COMMANDS[command](...args));
    if (!$.AXIsProcessTrusted()) throw new Error('not_trusted');
    return JSON.stringify(COMMANDS[command](application(), ...args));
  } catch (error) {
    return JSON.stringify({ error: String(error.message || error) });
  }
}
