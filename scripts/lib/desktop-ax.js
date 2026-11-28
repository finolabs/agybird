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
ObjC.import('CoreGraphics');
ObjC.bindFunction('CGEventSourceSecondsSinceLastEventType', ['double', ['int', 'unsigned int']]);
ObjC.bindFunction('CGSessionCopyCurrentDictionary', ['id', []]);
ObjC.bindFunction('CGWindowListCopyWindowInfo', ['id', ['unsigned int', 'unsigned int']]);

const BUNDLE_ID = 'com.google.antigravity';
const MAX_NODES = 20000;
const REQUIRED_LABELS = ['Message input', 'Select project', 'Select model', 'Agent permissions preset selector'];

// desktop-decisions:start
// Pure decisions over the flat node list a tree walk returns: { role, label,
// depth } plus `value` where a test recorded one, and `truncated` set on the
// list when the walk stopped at its node cap. Nothing here calls the
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

// The conversation on screen: the one titled web area in the tree, as the
// range [start, end) of its subtree, or null while none is titled. The window
// holds an untitled web area beside the titled one. A second titled web area
// (another conversation window or pane) throws: the tree then cannot say whose
// a control is, so nothing is read or pressed. So does a read cut off at the
// node cap: what lies past the cut (a second conversation, a rival composer or
// Send, the Stop that says the turn still runs, the rest of the reply) cannot
// be ruled out, and every decision below starts here.
function conversationArea(nodes) {
  if (nodes.truncated) throw new Error('truncated: the accessibility tree is too large to read whole');
  let area = null;
  for (let index = 0; index < nodes.length; index += 1) {
    if (nodes[index].role !== 'AXWebArea' || !nodes[index].label) continue;
    if (area) throw new Error('several_conversations: more than one titled conversation in the app');
    area = { start: index, end: subtreeEnd(nodes, index) };
  }
  return area;
}

// The conversation on screen, as the web area's title: "<title> - <project> -
// Antigravity", or "Antigravity" before a new conversation has been sent.
function title(nodes) {
  const area = conversationArea(nodes);
  return area ? nodes[area.start].label : null;
}

// The indexes of the nodes that pass `test`, all inside the conversation on
// screen. One outside it throws, as the run cannot tell whose it is; with no
// titled conversation there is none.
function withinConversation(nodes, test, what) {
  const area = conversationArea(nodes);
  const found = [];
  if (!area) return found;
  nodes.forEach((node, index) => {
    if (!test(node)) return;
    if (index <= area.start || index >= area.end) throw new Error(`outside_conversation: ${what}`);
    found.push(index);
  });
  return found;
}

// The index just past the reply that the `Agent said` heading at nodes[heading]
// opens: the nodes after it at its own depth, up to the next heading, the
// response actions, a control or the end of the parent. 2.35 renders the reply
// as one group; 2.36 as several (the time worked, the text, lists).
function replyEnd(nodes, heading, limit) {
  const depth = nodes[heading].depth;
  let next = subtreeEnd(nodes, heading);
  while (next < limit && nodes[next].depth === depth) {
    const entry = nodes[next];
    if (entry.role === 'AXHeading' || (entry.role === 'AXGroup' && entry.label === 'Response actions') || CONTROLS.indexOf(entry.role) >= 0) break;
    next = subtreeEnd(nodes, next);
  }
  return next;
}

// The last line of every prompt a run sends, naming that run: `nonce` is
// random hex the runner draws for it. A missing or malformed nonce throws, so
// no check is ever skipped for want of one.
function marker(nonce) {
  if (!/^[0-9a-f]{16,64}$/.test(String(nonce || ''))) throw new Error('usage: the run marker is 16 to 64 lowercase hex digits');
  return `[agybird-run ${nonce}]`;
}

// Whether the conversation on screen shows the run's own message: the text of
// the titled web area (the conversation the title names), outside the agent's
// replies and the sidebar, holds the run's marker. Only the run's prompt carries that marker,
// so another conversation, a namesake included, does not; an agent repeating
// it in a reply does not count. The marker is the message's last line, so the
// texts are read from the end, and the first one holding it, alone or joined
// to the text after it (a line split in two), ends the search.
function ownConversation(nodes, nonce, read) {
  const textOf = read || readNode;
  const wanted = marker(nonce);
  const area = conversationArea(nodes);
  if (!area) return false;
  const end = area.end;
  const texts = [];
  for (let at = area.start + 1; at < end; at += 1) {
    const node = nodes[at];
    if (node.role === 'AXHeading' && node.label === 'Agent said') {
      at = replyEnd(nodes, at, end) - 1;
    } else if (node.role === 'AXGroup' && node.label === 'Sidebar') {
      // 2.36 draws the sidebar inside the titled web area; its conversation
      // titles are not this conversation's text.
      at = subtreeEnd(nodes, at) - 1;
    } else if (node.role === 'AXStaticText') {
      texts.push(node);
    }
  }
  let after = '';
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const here = flatten(textOf(texts[index]));
    if (here.indexOf(wanted) >= 0 || flatten(`${here} ${after}`).indexOf(wanted) >= 0) return true;
    after = here;
  }
  return false;
}

// Throws unless the conversation on screen is the run's: titled `expected`
// and showing the run's own message, in this one read.
function requireOwn(nodes, expected, nonce, read) {
  if (!expected) throw new Error('usage: the expected conversation title is required');
  marker(nonce);
  if (title(nodes) !== expected) throw new Error('other_conversation');
  if (!ownConversation(nodes, nonce, read)) throw new Error("not_own: the run's own message is not on screen");
}

// After Send, the titled conversation on screen is the run's own only when it
// shows the run's own message, marker included, in the same read as the
// title. Returns { title } to adopt, { refused } for a conversation of another
// project, or null while the app has not titled the run's conversation, or
// shows one without its message (the user's, say), so Send keeps waiting.
function namedConversation(nodes, expected, project, nonce, read) {
  const shown = title(nodes);
  if (shown === null || shown === expected) return null;
  const suffix = ` - ${project} - ${UNTITLED}`;
  if (!project || shown.length <= suffix.length || shown.slice(-suffix.length) !== suffix) return { refused: shown };
  return ownConversation(nodes, nonce, read) ? { title: shown } : null;
}

// Every permission dialog on screen. A dialog is the smallest group that holds
// an option 1 radio and a Skip button. Its question is every static text inside
// that group, in order, outside the options, buttons and inputs: rendered
// Markdown splits a question into word and code-span nodes. Its options, Skip
// and Submit are found inside the same group only. A group holding two option
// 1 radios is marked ambiguous. Only dialogs inside the conversation on screen
// count, and an option 1 outside it throws (withinConversation).
function dialogs(nodes, read) {
  const textOf = read || readNode;
  const found = [];
  const groups = [];
  const area = conversationArea(nodes);
  withinConversation(nodes, isOption1, 'permission dialog').forEach((index) => {
    for (let group = parentOf(nodes, index); group > area.start; group = parentOf(nodes, group)) {
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
      // Only a dialog whose option 1 is the app's permission answer is a
      // permission prompt; an agent's own question ("1 Red", "2 Blue") is not.
      found.push({ question: flatten(parts.join(' ')), options, option1, skip, submit: inside((entry) => isButton(entry, 'Submit')), ambiguous: firsts > 1, permission: option1 >= 0 && nodes[option1].label.trim() === OPTION_1 });
      return;
    }
  });
  return found;
}

// The nodes to press, in order, to answer the dialog that asks `question`, the
// whole flattened question, in the conversation titled `expected` that shows
// the run's own message (`nonce`). Any mismatch throws and nothing is pressed.
function chooseAnswer(nodes, option, question, expected, nonce, read) {
  if (ANSWERS.indexOf(option) < 0) throw new Error('refused: only 1 or Skip may be answered');
  if (!question || !expected) throw new Error('usage: answer <1|Skip> <question> <conversation title> <run marker>');
  marker(nonce);
  const shown = dialogs(nodes, read);
  if (shown.length === 0) throw new Error('not_found: permission dialog');
  requireOwn(nodes, expected, nonce, read);
  const matching = shown.filter((prompt) => prompt.question === question);
  // A dialog whose option 1 is not the app's permission answer (an agent's own
  // question, or a wider grant) is never answered.
  if (matching.length > 0 && !matching.some((prompt) => prompt.permission)) throw new Error('not_found: option 1');
  const asking = matching.filter((prompt) => prompt.permission);
  if (asking.length === 0) throw new Error('question_changed');
  if (asking.length > 1 || asking[0].ambiguous) throw new Error('several_dialogs');
  const prompt = asking[0];
  if (option === 'Skip') return [{ index: prompt.skip, what: 'Skip' }];
  if (nodes[prompt.option1].label.trim() !== OPTION_1) throw new Error('not_found: option 1');
  if (prompt.submit < 0) throw new Error('not_found: Submit');
  return [{ index: prompt.option1, what: 'option 1' }, { index: prompt.submit, what: 'Submit' }];
}

// 2.35 shows Stop execution while a turn runs; 2.36 shows Cancel (⌃C) in the
// composer, and its turn under an `Agent working` heading.
const isStop = (node) => isButton(node, 'Stop execution') || isButton(node, 'Cancel (');
const isWorking = (node) => node.role === 'AXHeading' && node.label === 'Agent working';

// Whether the conversation on screen shows a turn going.
function running(nodes) {
  return withinConversation(nodes, isStop, 'Stop execution').length > 0 || withinConversation(nodes, isWorking, 'Agent working').length > 0;
}

// The Stop execution (2.35) or Cancel (2.36) button to press in the run's own
// conversation.
function chooseStop(nodes, expected, nonce, read) {
  requireOwn(nodes, expected, nonce, read);
  const found = withinConversation(nodes, isStop, 'Stop execution');
  if (found.length === 0) throw new Error('not_found: Stop execution');
  return found[0];
}

// The Copy button of the last reply's response actions in the run's own
// conversation.
function chooseCopy(nodes, expected, nonce, read) {
  requireOwn(nodes, expected, nonce, read);
  const groups = withinConversation(nodes, (node) => node.role === 'AXGroup' && node.label === 'Response actions', 'Response actions');
  if (groups.length === 0) throw new Error('not_found: Response actions');
  const group = groups[groups.length - 1];
  const end = subtreeEnd(nodes, group);
  for (let index = group + 1; index < end; index += 1) if (nodes[index].role === 'AXButton' && nodes[index].label === 'Copy') return index;
  throw new Error('not_found: Copy');
}

const COMPOSER = { 'Message input': 'AXTextArea', 'Send message': 'AXButton' };

// The composer (`Message input`) or `Send message` of the conversation titled
// `expected`, as an index, or -1 while there is none (Send shows only once the
// composer holds text). Before Send the run's conversation is the new one,
// titled "Antigravity" and without the run's marker yet, so its scope is the
// single titled web area with that title. The control must be the only one of
// its kind in the whole tree and lie inside that web area: one anywhere else
// (an untitled pane's composer, say) or a second inside throws, so nothing is
// pasted, cleared or sent.
function chooseComposer(nodes, expected, control) {
  if (!COMPOSER[control] || !expected) throw new Error('usage: chooseComposer <nodes> <expected title> <Message input|Send message>');
  if (title(nodes) !== expected) throw new Error('other_conversation');
  const found = withinConversation(nodes, (node) => node.role === COMPOSER[control] && node.label.startsWith(control), control);
  if (found.length > 1) throw new Error(`several_controls: ${control}`);
  return found.length ? found[0] : -1;
}

// The last reply in the conversation on screen: the groups after the last
// `Agent said` heading, at the heading's own depth, up to the response actions
// that follow (replyEnd); null until the first of them is a group.
function reply(nodes, read) {
  const textOf = read || readNode;
  const headings = withinConversation(nodes, (node) => node.role === 'AXHeading' && node.label === 'Agent said', 'Agent said');
  if (headings.length === 0) return null;
  const heading = headings[headings.length - 1];
  const depth = nodes[heading].depth;
  const start = subtreeEnd(nodes, heading);
  if (start >= nodes.length || nodes[start].depth !== depth || nodes[start].role !== 'AXGroup') return null;
  const end = replyEnd(nodes, heading, nodes.length);
  const lines = [];
  for (let index = start; index < end; index += 1) {
    if (nodes[index].role === 'AXStaticText') lines.push(textOf(nodes[index]));
  }
  return lines.join('\n');
}

// How a new conversation opens. 2.35 lists each project in the sidebar, its
// name button followed by its own `New Conversation in Project` link:
// { layout: 'sidebar', index } of that link. 2.36 has one `New Conversation`
// link and picks the project in the new conversation's composer: { layout:
// 'picker', index } of that link, which must be the only one.
function chooseNewConversation(nodes, project) {
  if (!project) throw new Error('usage: new-conversation <project>');
  if (nodes.truncated) throw new Error('truncated: the accessibility tree is too large to read whole');
  if (nodes.some((node) => node.role === 'AXLink' && node.label === 'New Conversation in Project')) {
    const start = nodes.findIndex((node) => node.role === 'AXButton' && node.label === project);
    if (start < 0) throw new Error(`not_found: project ${project}`);
    const link = nodes.findIndex((node, index) => index > start && node.role === 'AXLink' && node.label === 'New Conversation in Project');
    if (link < 0) throw new Error('not_found: New Conversation in Project');
    return { layout: 'sidebar', index: link };
  }
  const links = [];
  nodes.forEach((node, index) => {
    if (node.role === 'AXLink' && node.label === 'New Conversation') links.push(index);
  });
  if (links.length === 0) throw new Error('not_found: New Conversation');
  if (links.length > 1) throw new Error('several_controls: New Conversation');
  return { layout: 'picker', index: links[0] };
}

// A pop-up of the new (untitled) conversation's composer, `<prefix>, current:
// <value>`, as { index, current }: the only one in the tree, inside that
// conversation.
function choosePicker(nodes, prefix) {
  const label = `${prefix}, current: `;
  if (title(nodes) !== UNTITLED) throw new Error('other_conversation');
  const found = withinConversation(nodes, (node) => node.role === 'AXPopUpButton' && node.label.startsWith(label), prefix);
  if (found.length === 0) throw new Error(`not_found: ${prefix}`);
  if (found.length > 1) throw new Error(`several_controls: ${prefix}`);
  return { index: found[0], current: nodes[found[0]].label.slice(label.length) };
}

// The new conversation's agent must run on this Mac, where its working tree is
// the one the run checks; anything else fails closed.
const LOCAL = 'This Computer';
function requireLocal(nodes) {
  const where = choosePicker(nodes, 'Where the agent runs').current;
  if (where !== LOCAL) throw new Error(`not_local: the agent runs on ${where}, not ${LOCAL}`);
}

// The open project picker of the new conversation: the one menu labelled
// `Select project, current: …`, as the range [start, end) of its subtree.
function projectMenu(nodes) {
  // Only while the untitled new conversation shows, as choosePicker requires.
  if (title(nodes) !== UNTITLED) throw new Error('other_conversation');
  const found = withinConversation(nodes, (node) => node.role === 'AXMenu' && node.label.startsWith('Select project, current: '), 'project picker');
  if (found.length === 0) throw new Error('not_found: project picker');
  if (found.length > 1) throw new Error('several_controls: project picker');
  return { start: found[0], end: subtreeEnd(nodes, found[0]) };
}

// The picker's Search Projects field.
function chooseProjectSearch(nodes) {
  const menu = projectMenu(nodes);
  const found = [];
  for (let at = menu.start + 1; at < menu.end; at += 1) if (nodes[at].role === 'AXTextField' && nodes[at].label === 'Search Projects') found.push(at);
  if (found.length !== 1) throw new Error(found.length ? 'several_controls: Search Projects' : 'not_found: Search Projects');
  return found[0];
}

// The picker's item for `project`: a menu item labelled `<project> Project
// Settings` whose own text, outside its buttons, is exactly `project`. Near
// names (agybird-wt-agy for agybird) never match; two exact ones refuse.
function chooseProjectItem(nodes, project, read) {
  const textOf = read || readNode;
  const menu = projectMenu(nodes);
  const found = [];
  for (let at = menu.start + 1; at < menu.end; at += 1) {
    if (nodes[at].role !== 'AXMenuItem' || nodes[at].label !== `${project} Project Settings`) continue;
    const end = subtreeEnd(nodes, at);
    const parts = [];
    for (let inner = at + 1; inner < end; inner += 1) {
      if (CONTROLS.indexOf(nodes[inner].role) >= 0) inner = subtreeEnd(nodes, inner) - 1;
      else if (nodes[inner].role === 'AXStaticText') parts.push(String(textOf(nodes[inner])));
    }
    if (flatten(parts.join(' ')) === project) found.push(at);
  }
  if (found.length === 0) throw new Error(`not_found: project ${project}`);
  if (found.length > 1) throw new Error(`several_controls: project ${project}`);
  return found[0];
}
// The conversations the 2.36 sidebar lists, each with the status heading it
// sits under: `In Progress` (the agent works), `Blocked` (it waits for the
// user) or `Idle`. A row is a link titled with the conversation's title whose
// row group also shows the project's name. Rows under no status heading
// (pinned ones) have a null status. Only the one group labelled `Sidebar` is
// read: a conversation's own text (rendered Markdown, links included) can
// show the same headings and links, and is never taken for a row.
const SIDEBAR_STATUSES = ['In Progress', 'Blocked', 'Idle'];
function sidebarRange(nodes) {
  const groups = [];
  nodes.forEach((node, index) => {
    if (node.role === 'AXGroup' && node.label === 'Sidebar') groups.push(index);
  });
  return groups.length === 1 ? { start: groups[0] + 1, end: subtreeEnd(nodes, groups[0]) } : null;
}
function sidebarRows(nodes, read) {
  const textOf = read || readNode;
  const rows = [];
  const range = sidebarRange(nodes);
  if (!range) return rows;
  let status = null;
  for (let index = range.start; index < range.end; index += 1) {
    const node = nodes[index];
    if (node.role === 'AXHeading') {
      if (SIDEBAR_STATUSES.indexOf(node.label) >= 0) status = node.label;
      else if (/Conversations$/.test(node.label)) status = null;
      continue;
    }
    if (node.role !== 'AXLink' || !node.label) continue;
    const row = parentOf(nodes, index);
    if (row < range.start) continue;
    const texts = [];
    for (let at = row + 1; at < subtreeEnd(nodes, row); at += 1) if (nodes[at].role === 'AXStaticText') texts.push(String(textOf(nodes[at])).trim());
    if (texts.length >= 2 && texts[0] === node.label) rows.push({ index, title: node.label, project: texts[1], status });
  }
  return rows;
}

// The sidebar rows of `title` in `project`, with whether the read showed any
// status heading in the sidebar at all (a sidebar grouped some other way, or
// no single sidebar, shows none).
function sidebarState(nodes, title, project, read) {
  const range = sidebarRange(nodes);
  let grouped = false;
  if (range) for (let at = range.start; at < range.end; at += 1) if (nodes[at].role === 'AXHeading' && SIDEBAR_STATUSES.indexOf(nodes[at].label) >= 0) grouped = true;
  const rows = sidebarRows(nodes, read).filter((row) => row.title === title && row.project === project);
  return { grouped, rows };
}

// The Archive button of the one sidebar row of `title` in `project`, only when
// that row is alone and under Idle: a running, waiting or namesake row is
// never archived. Throws the reason otherwise.
function archiveButton(nodes, title, project, read) {
  if (nodes.truncated) throw new Error('truncated');
  const shown = sidebarState(nodes, title, project, read);
  if (shown.rows.length === 0) throw new Error(`not_found: sidebar row ${title}`);
  if (shown.rows.length > 1) throw new Error(`several_rows: ${title}`);
  if (shown.rows[0].status !== 'Idle') throw new Error(`not_idle: ${shown.rows[0].status}`);
  const row = parentOf(nodes, shown.rows[0].index);
  const buttons = [];
  for (let at = row + 1; at < subtreeEnd(nodes, row); at += 1) if (nodes[at].role === 'AXButton' && nodes[at].label === 'Archive conversation') buttons.push(at);
  if (buttons.length === 0) throw new Error('not_found: Archive conversation');
  if (buttons.length > 1) throw new Error('several_controls: Archive conversation');
  return buttons[0];
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

// Stops at MAX_NODES, and then marks the list `truncated`, so no decision takes
// the part read for the whole app (conversationArea).
function walk(element, nodes, depth = 0) {
  if (nodes.length >= MAX_NODES) {
    nodes.truncated = true;
    return nodes;
  }
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

// The bridge can hand NSArray.count over as a string, and "0" is truthy, so
// every count is read through Number().
function runningApps(bundleId) {
  return $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundleId);
}

function runningApp() {
  const apps = runningApps(BUNDLE_ID);
  return Number(apps.count) > 0 ? apps.objectAtIndex(0) : null;
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

// What `pick` returns from a tree read, once the app has rendered a step: the
// read is retried for a few seconds while `pick` throws, then its last error
// is thrown. A read cut off at the node cap throws in every decision.
function settled(app, pick) {
  let failure = null;
  for (let tries = 0; tries < 15; tries += 1) {
    if (tries > 0) delay(0.2);
    try {
      return pick(tree(app));
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

// How long Send waits for the app to title the new conversation.
const TITLE_WAIT_MS = 30000;

// `running`, `dialog` and `reply` come from the conversation on screen only;
// a second titled conversation, or one of them outside it, fails the read. A
// read cut off at the node cap is marked `truncated` and shows no conversation:
// no title, running state, dialog or reply, so the runner never takes it as a
// turn that ended or as an app with no run.
function snapshot(nodes) {
  const labels = {};
  for (const label of REQUIRED_LABELS) labels[label] = nodes.some((node) => node.label.startsWith(label));
  if (nodes.truncated) {
    return { labels, preset: current(nodes, 'Agent permissions preset selector'), model: current(nodes, 'Select model'), project: current(nodes, 'Select project'), location: current(nodes, 'Where the agent runs'), truncated: true, title: null, running: null, sendable: false, dialog: null, reply: null };
  }
  return {
    labels,
    preset: current(nodes, 'Agent permissions preset selector'),
    model: current(nodes, 'Select model'),
    project: current(nodes, 'Select project'),
    // 2.36 only; null on 2.35, which has no such picker.
    location: current(nodes, 'Where the agent runs'),
    title: title(nodes),
    running: running(nodes),
    sendable: Boolean(find(nodes, 'AXButton', 'Send message')),
    dialog: dialogs(nodes, staticText).map((prompt) => ({ question: prompt.question, options: prompt.options, permission: prompt.permission }))[0] || null,
    reply: reply(nodes, staticText),
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
  const nodes = showing(app, expected);
  // Only the composer of the conversation on screen (chooseComposer).
  const input = nodes[chooseComposer(nodes, expected, 'Message input')];
  if (!input) throw new Error('not_found: Message input');
  if (!isFrontmost()) throw new Error('not_frontmost');
  $.AXUIElementSetAttributeValue(input.element, $('AXFocused'), $.NSNumber.numberWithBool(true));
  return input;
}

// kCGEventSourceStateHIDSystemState and kCGAnyInputEventType: the time since
// the user last typed, clicked or moved the mouse.
const HID_SYSTEM_STATE = 1;
const ANY_INPUT_EVENT = 0xFFFFFFFF;
// kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements: the
// windows of the Space on screen, never those of other Spaces or minimized ones.
const ON_SCREEN_WINDOWS = 1 | 16;

// `idle` seconds since the last input, `locked` for a locked screen, and
// `on_screen` for an app window on the Space shown, which a switch to the app
// reaches without moving to another Space.
function presence(app) {
  const session = $.CGSessionCopyCurrentDictionary();
  const locked = session && !session.isNil() ? session.objectForKey($('CGSSessionScreenIsLocked')) : null;
  let onScreen = null;
  if (app) {
    const pid = Number(app.processIdentifier);
    const windows = $.CGWindowListCopyWindowInfo(ON_SCREEN_WINDOWS, 0);
    onScreen = false;
    for (let index = 0; index < Number(windows.count) && !onScreen; index += 1) {
      const window = windows.objectAtIndex(index);
      onScreen = Number(window.objectForKey($('kCGWindowOwnerPID')).js) === pid && Number(window.objectForKey($('kCGWindowLayer')).js) === 0;
    }
  }
  return {
    idle: $.CGEventSourceSecondsSinceLastEventType(HID_SYSTEM_STATE, ANY_INPUT_EVENT),
    locked: Boolean(locked && !locked.isNil() && locked.js),
    on_screen: onScreen,
  };
}

function readStdin() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  return $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
}

// NSPasteboardContentsCurrentHostOnly: kept off Universal Clipboard.
const CURRENT_HOST_ONLY = 1;
// The nspasteboard.org markers: clipboard managers skip the item and keep no history of it.
const PROMPT_MARKERS = ['org.nspasteboard.TransientType', 'org.nspasteboard.ConcealedType'];
const TEXT_TYPES = ['public.utf8-plain-text', 'public.utf16-external-plain-text', 'public.utf16-plain-text', 'NSStringPboardType'];

function boardTypes(board) {
  const list = board.types;
  const out = [];
  if (list && !list.isNil()) for (let index = 0; index < list.count; index += 1) out.push(text(list.objectAtIndex(index)));
  return out;
}

// Every write first empties the pasteboard; `options` 0 or CURRENT_HOST_ONLY.
function writeText(value, markers, options) {
  const board = $.NSPasteboard.generalPasteboard;
  board.prepareForNewContentsWithOptions(options);
  if (value === null || value === undefined) return;
  board.setStringForType($(value), $.NSPasteboardTypeString);
  for (const marker of markers) board.setStringForType($(''), $(marker));
}

// A clipboard up to this size is saved whole, every item in every type it
// carries; a larger one keeps only its text.
const MAX_SAVED_BYTES = 16 * 1024 * 1024;

// Every item of the clipboard as { type: base64 data }, or null past MAX_SAVED_BYTES.
function boardItems(board) {
  const items = board.pasteboardItems;
  const out = [];
  let bytes = 0;
  if (!items || items.isNil()) return out;
  for (let index = 0; index < Number(items.count); index += 1) {
    const item = items.objectAtIndex(index);
    const types = item.types;
    const saved = {};
    for (let at = 0; at < Number(types.count); at += 1) {
      const type = text(types.objectAtIndex(at));
      const data = item.dataForType($(type));
      if (!data || data.isNil()) continue;
      bytes += Number(data.length);
      if (bytes > MAX_SAVED_BYTES) return null;
      saved[type] = data.base64EncodedStringWithOptions(0).js;
    }
    out.push(saved);
  }
  return out;
}

// The text with the nspasteboard.org markers it carried, and, up to
// MAX_SAVED_BYTES, every item whole (`items`). `other` says the clipboard also
// held something else (an image, a file, rich text), which only `items` keeps.
const CLIPBOARD = {
  'clipboard-get'() {
    const board = $.NSPasteboard.generalPasteboard;
    const value = board.stringForType($.NSPasteboardTypeString);
    const types = boardTypes(board);
    return {
      text: value && !value.isNil() ? value.js : null,
      markers: types.filter((type) => type.indexOf('org.nspasteboard.') === 0),
      other: types.some((type) => type.indexOf('org.nspasteboard.') !== 0 && TEXT_TYPES.indexOf(type) < 0),
      items: boardItems(board),
    };
  },
  // The prompt: on this Mac only, marked transient and concealed.
  'clipboard-set'() {
    writeText(readStdin(), PROMPT_MARKERS, CURRENT_HOST_ONLY);
    return { ok: true };
  },
  // What clipboard-get saved, as JSON on stdin: every item whole when it saved
  // them, else its text and its own markers.
  'clipboard-restore'() {
    const saved = JSON.parse(readStdin());
    if (Array.isArray(saved.items) && saved.items.length > 0) {
      const board = $.NSPasteboard.generalPasteboard;
      board.prepareForNewContentsWithOptions(0);
      const items = $.NSMutableArray.array;
      for (const entry of saved.items) {
        const item = $.NSPasteboardItem.alloc.init;
        for (const type of Object.keys(entry)) {
          const data = typeof entry[type] === 'string' ? $.NSData.alloc.initWithBase64EncodedStringOptions($(entry[type]), 0) : null;
          if (!data || data.isNil() || !item.setDataForType(data, $(type))) throw new Error('restore_failed');
        }
        items.addObject(item);
      }
      // The board was emptied above: a failed write is reported, never taken as restored.
      if (!board.writeObjects(items)) throw new Error('restore_failed');
      return { ok: true };
    }
    writeText(saved.text, (saved.markers || []).filter((type) => /^org\.nspasteboard\.[A-Za-z]+$/.test(type)), 0);
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
      ...presence(app),
    };
  },
  // With the run's nonce, `own` says whether this same read shows the run's own message.
  snapshot(app, nonce) {
    const nodes = tree(app);
    const shot = snapshot(nodes);
    if (nonce !== undefined) shot.own = !shot.truncated && ownConversation(nodes, nonce, staticText);
    return shot;
  },
  // 2.35: the project's own sidebar link. 2.36: the New Conversation link,
  // then, unless the new conversation is already in the project, its project
  // picker: open it, filter it to the name, press the item named exactly that,
  // and read the picker back. The agent must run on This Computer before and
  // after. Where it runs, the branch, the model and the preset are never
  // changed; any mismatch throws, and nothing is pasted or sent.
  'new-conversation'(app, project) {
    const shown = tree(app);
    const opened = chooseNewConversation(shown, project);
    if (opened.layout === 'sidebar') {
      press(shown[opened.index], 'New Conversation in Project');
      return { ok: true };
    }
    press(shown[opened.index], 'New Conversation');
    let picker = settled(app, (nodes) => {
      requireLocal(nodes);
      return { nodes, picker: choosePicker(nodes, 'Select project') };
    });
    if (picker.picker.current !== project) {
      press(picker.nodes[picker.picker.index], 'Select project');
      const field = settled(app, (nodes) => nodes[chooseProjectSearch(nodes)]);
      if ($.AXUIElementSetAttributeValue(field.element, $('AXValue'), $(project)) !== 0) throw new Error('set_failed: Search Projects');
      press(settled(app, (nodes) => nodes[chooseProjectItem(nodes, project, staticText)]), `project ${project}`);
      picker = settled(app, (nodes) => {
        const now = choosePicker(nodes, 'Select project');
        if (now.current !== project) throw new Error(`project_unchanged: the new conversation shows project ${now.current}`);
        return { nodes, picker: now };
      });
    }
    requireLocal(picker.nodes);
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
    if (!(Number(runningApps(bundleId).count) > 0)) return { ok: false };
    shell.doShellScript(`/usr/bin/open -b ${bundleId}`);
    delay(0.3);
    const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    return { ok: Boolean(front) && text(front.bundleIdentifier) === bundleId };
  },
  // Needs the app in front, only until the paste lands: once the composer
  // holds text the runner gives the front back and reads it with read-input.
  'paste-input'(app, expectedTitle) {
    const input = focusInput(app, expectedTitle);
    menu(app, 'Edit', 'Paste');
    for (let tries = 0; tries < 30; tries += 1) {
      delay(0.2);
      if (text(get(input.element, 'AXValue')).trim()) return { ok: true, landed: true };
    }
    return { ok: true, landed: false };
  },
  // Reads the composer of the expected conversation, with the app in front or
  // not, until its text is non-blank and steady; a long prompt takes seconds.
  'read-input'(app, expectedTitle) {
    const nodes = showing(app, expectedTitle);
    const input = nodes[chooseComposer(nodes, expectedTitle, 'Message input')];
    if (!input) throw new Error('not_found: Message input');
    let value = '';
    for (let tries = 0; tries < 30; tries += 1) {
      const next = inputText(input);
      if (next.trim() && next === value) break;
      value = next;
      delay(0.2);
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
  // returns the title the app gives it, read in this same call, once
  // namedConversation() finds the run's own message, marker included, under
  // it in the same read: that title is the run's conversation from then on. A
  // conversation of another project returns as `refused`; so does any other
  // title seen when the wait ends with none adopted; no title returns null.
  send(app, expectedTitle, project, nonce) {
    if (!project) throw new Error('usage: send <expected title> <project> <run marker>');
    marker(nonce);
    // The button appears only once the input holds text, which can lag the paste.
    let button = null;
    for (let tries = 0; tries < 10 && !button; tries += 1) {
      if (tries > 0) delay(0.2);
      const nodes = showing(app, expectedTitle);
      // Only the Send of the conversation on screen (chooseComposer).
      button = nodes[chooseComposer(nodes, expectedTitle, 'Send message')] || null;
    }
    press(button, 'Send message');
    const until = Date.now() + TITLE_WAIT_MS;
    let seen = null;
    // An error from here on (a second titled conversation, say) comes after the
    // press, so it is never reported as a refusal before it.
    try {
      while (Date.now() < until) {
        delay(0.25);
        const now = tree(app);
        // A cut-off read can neither show the run's message nor rule out
        // another conversation, so the wait goes on.
        if (now.truncated) continue;
        const named = namedConversation(now, expectedTitle, project, nonce, staticText);
        if (named && named.title) return { ok: true, title: named.title };
        if (named && named.refused) return { ok: true, title: null, refused: named.refused };
        if (title(now) !== null && title(now) !== expectedTitle) seen = title(now);
      }
    } catch (error) {
      throw new Error(`after_send: ${error.message}`);
    }
    return seen ? { ok: true, title: null, refused: seen } : { ok: true, title: null };
  },
  // An answer is pressed only in the same tree read that shows the expected
  // conversation with the run's own message, the approved question and, for
  // option 1, its exact label.
  answer(app, option, question, expectedTitle, nonce) {
    if (!ANSWERS.includes(option)) throw new Error('refused: only 1 or Skip may be answered');
    const nodes = tree(app);
    for (const target of chooseAnswer(nodes, option, question, expectedTitle, nonce, staticText)) press(nodes[target.index], target.what);
    return { ok: true };
  },
  // Puts the last reply, as the app's own Markdown, on the clipboard and reads
  // it back in the same call, so the runner can restore the clipboard at once.
  // The app writes it there unmarked; that window is as short as this call.
  'copy-reply'(app, expectedTitle, nonce) {
    const nodes = tree(app);
    // Only the Copy of the run's own conversation, found inside it (chooseCopy).
    const button = nodes[chooseCopy(nodes, expectedTitle, nonce, staticText)];
    // The copy lands asynchronously; an unchanged pasteboard means it did not.
    const board = $.NSPasteboard.generalPasteboard;
    const before = board.changeCount;
    press(button, 'Copy');
    for (let tries = 0; tries < 20 && board.changeCount === before; tries += 1) delay(0.1);
    if (board.changeCount === before) throw new Error('copy_unchanged');
    const value = board.stringForType($.NSPasteboardTypeString);
    return { ok: true, text: value && !value.isNil() ? value.js : null };
  },
  // The run's rows in the sidebar, read with the app behind and the view unchanged.
  'sidebar-state'(app, title, project) {
    if (!title || !project) throw new Error('usage: sidebar-state <title> <project>');
    const nodes = tree(app);
    if (nodes.truncated) throw new Error('truncated');
    const shown = sidebarState(nodes, title, project, staticText);
    return { grouped: shown.grouped, statuses: shown.rows.map((row) => row.status) };
  },
  // Opens the `n`th (0-based) row of `title` in `project` from the sidebar:
  // the view changes, the front does not.
  'open-row'(app, name, project, n) {
    if (!name || !project) throw new Error('usage: open-row <title> <project> <n>');
    const nodes = tree(app);
    if (nodes.truncated) throw new Error('truncated');
    const rows = sidebarState(nodes, name, project, staticText).rows;
    const row = rows[Number(n) || 0];
    if (!row) throw new Error(`not_found: sidebar row ${name}`);
    press(nodes[row.index], 'sidebar row');
    // The view switch lands asynchronously; the runner reads the window again
    // until it shows the row's conversation (each read of the tree takes about
    // a second on a large app, so none is made here).
    delay(0.3);
    return { ok: true, rows: rows.length };
  },
  // Archives the one Idle sidebar row of `title` in `project`, with the app
  // behind: the row leaves the sidebar, the conversation is kept (archived).
  'archive-row'(app, name, project) {
    if (!name || !project) throw new Error('usage: archive-row <title> <project>');
    const nodes = tree(app);
    if (nodes.truncated) throw new Error('truncated');
    press(nodes[archiveButton(nodes, name, project, staticText)], 'Archive conversation');
    return { ok: true };
  },
  stop(app, expectedTitle, nonce) {
    const nodes = tree(app);
    // Only the Stop of the run's own conversation, found inside it (chooseStop).
    press(nodes[chooseStop(nodes, expectedTitle, nonce, staticText)], 'Stop execution');
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
