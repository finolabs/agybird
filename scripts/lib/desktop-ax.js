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
const ANSWERS = { 1: '1 ', Skip: 'Skip' };

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

function walk(element, nodes) {
  if (nodes.length >= MAX_NODES) return nodes;
  const node = { role: text(get(element, 'AXRole')), label: text(get(element, 'AXDescription')) || text(get(element, 'AXTitle')), element };
  nodes.push(node);
  for (const child of children(element)) walk(child, nodes);
  return nodes;
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

function dialog(nodes) {
  const first = nodes.findIndex((node) => node.role === 'AXRadioButton' && node.label.startsWith('1 '));
  if (first < 0 || !find(nodes, 'AXButton', 'Skip')) return null;
  let question = '';
  for (let index = first - 1; index >= 0 && !question; index -= 1) {
    if (nodes[index].role === 'AXStaticText') question = staticText(nodes[index]).trim();
  }
  const options = nodes.filter((node) => node.role === 'AXRadioButton' && /^\d /.test(node.label)).map((node) => node.label);
  return { question, options };
}

function reply(nodes) {
  let last = -1;
  nodes.forEach((node, index) => {
    if (node.role === 'AXStaticText' && staticText(node) === 'Agent said') last = index;
  });
  if (last < 0) return null;
  return nodes.slice(last + 1).filter((node) => node.role === 'AXStaticText').map(staticText).filter(Boolean).join('\n');
}

function snapshot(nodes) {
  const labels = {};
  for (const label of REQUIRED_LABELS) labels[label] = nodes.some((node) => node.label.startsWith(label));
  return {
    labels,
    preset: current(nodes, 'Agent permissions preset selector'),
    model: current(nodes, 'Select model'),
    project: current(nodes, 'Select project'),
    running: Boolean(find(nodes, 'AXButton', 'Stop execution')),
    sendable: Boolean(find(nodes, 'AXButton', 'Send message')),
    dialog: dialog(nodes),
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

function focusInput(app) {
  const input = find(tree(app), 'AXTextArea', 'Message input');
  if (!input) throw new Error('not_found: Message input');
  if (!isFrontmost()) throw new Error('not_frontmost');
  $.AXUIElementSetAttributeValue(input.element, $('AXFocused'), $.NSNumber.numberWithBool(true));
  return input;
}

const COMMANDS = {
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
    const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundleId);
    if (!apps.count) return { ok: false };
    return { ok: apps.objectAtIndex(0).activateWithOptions($.NSApplicationActivateIgnoringOtherApps) };
  },
  'paste-input'(app) {
    const input = focusInput(app);
    menu(app, 'Edit', 'Paste');
    return { ok: true, value: text(get(input.element, 'AXValue')) };
  },
  'clear-input'(app) {
    focusInput(app);
    menu(app, 'Edit', 'Select All');
    menu(app, 'Edit', 'Delete');
    return { ok: true };
  },
  send(app) {
    press(find(tree(app), 'AXButton', 'Send message'), 'Send message');
    return { ok: true };
  },
  answer(app, option) {
    if (!Object.prototype.hasOwnProperty.call(ANSWERS, option)) throw new Error('refused: only 1 or Skip may be answered');
    const nodes = tree(app);
    if (!dialog(nodes)) throw new Error('not_found: permission dialog');
    if (option === 'Skip') {
      press(find(nodes, 'AXButton', 'Skip'), 'Skip');
    } else {
      press(find(nodes, 'AXRadioButton', ANSWERS[option]), 'option 1');
      press(find(tree(app), 'AXButton', 'Submit'), 'Submit');
    }
    return { ok: true };
  },
  stop(app) {
    press(find(tree(app), 'AXButton', 'Stop execution'), 'Stop execution');
    return { ok: true };
  },
};

function run(argv) {
  const [command, ...args] = argv;
  try {
    if (!Object.prototype.hasOwnProperty.call(COMMANDS, command)) throw new Error(`unknown command: ${command}`);
    if (command === 'probe') return JSON.stringify(COMMANDS.probe());
    if (!$.AXIsProcessTrusted()) throw new Error('not_trusted');
    return JSON.stringify(COMMANDS[command](application(), ...args));
  } catch (error) {
    return JSON.stringify({ error: String(error.message || error) });
  }
}
