// Decisions of the desktop runner that need no app: what it refuses, what
// preflight blocks on, and how a snapshot becomes an envelope.

export const REQUIRED_LABELS = ['Message input', 'Select project', 'Select model', 'Agent permissions preset selector'];
export const TESTED_VERSION = /^2\.35\./;
const UNATTENDED_PRESETS = new Set(['Auto', 'Turbo']);
const MAX_FIELD = 300;
// The longest question shown whole, and so the longest that can be approved
// from outside the app; the match itself is on the whole question, uncut.
export const MAX_QUESTION = 4_000;

export class Blocked extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

// Options of the CLI runner that the app cannot honour, named so the caller
// knows which one to drop.
export function refusedOption(options) {
  if (options.category === 'image') return 'image generation (--category image)';
  if (options.swarm) return '--swarm';
  if (options.grants.length > 0) return '--grant';
  if (options.model !== undefined) return '--model';
  if (options.conversation !== undefined) return '--conversation';
  if (options.effort !== undefined) return '--effort';
  if (options.agent !== undefined) return '--agent';
  if (options.sandbox) return '--sandbox';
  return null;
}

export function checkPlatform(platform) {
  if (platform !== 'darwin') throw new Blocked('not_macos', 'The desktop transport runs only on macOS.');
}

export function checkProbe(probe, { platform, allowVersion }) {
  checkPlatform(platform);
  if (!probe.pid) throw new Blocked('app_missing', 'The Antigravity app is not running; open it and sign in, then retry.');
  if (!probe.trusted) throw new Blocked('not_trusted', 'Accessibility is not granted to the app that runs Agybird. Grant it in System Settings > Privacy & Security > Accessibility, then start a new session.');
  if (!allowVersion && !TESTED_VERSION.test(probe.version ?? '')) {
    throw new Blocked('unsupported_version', `Antigravity ${probe.version ?? '(unknown version)'} is outside the tested 2.35.x range; set AGYBIRD_DESKTOP_ALLOW_VERSION=1 to run anyway.`);
  }
}

export function checkLabels(snapshot) {
  const missing = REQUIRED_LABELS.filter((label) => !snapshot.labels?.[label]);
  if (missing.length > 0) throw new Blocked('labels_missing', `The Antigravity window lacks ${missing.join(', ')}: an unsupported app version or language.`);
}

export function presetWarnings(preset) {
  if (!UNATTENDED_PRESETS.has(preset)) return [];
  return [`Antigravity's permissions preset is ${preset}: the app may run commands and edit files without asking. Read mode detects working-tree changes after the fact; it cannot prevent them.`];
}

export function flatten(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function cut(value) {
  const flat = flatten(value);
  return flat.length > MAX_FIELD ? `${flat.slice(0, MAX_FIELD)}…` : flat;
}

// `question` is what the user is shown before an approval: the whole question,
// unless it is longer than MAX_QUESTION, when `question_truncated` is set and
// the companion refuses to approve it. `question_full` is what the app must
// still show, compared whole.
export function permissionRequest(dialog) {
  const wider = dialog.options.find((option) => /^2 /.test(option)) ?? '';
  const scope = /'([^']+)'/.exec(wider)?.[1] ?? null;
  const question = flatten(dialog.question);
  const truncated = question.length > MAX_QUESTION;
  return {
    tool: 'Antigravity app',
    target: cut(dialog.question),
    target_truncated: cut(dialog.question) !== question,
    suggested_rule: null,
    grantable: false,
    question: truncated ? `${question.slice(0, MAX_QUESTION)}…` : question,
    question_truncated: truncated,
    question_full: question,
    scope: scope === null ? null : cut(scope),
    options: dialog.options.map(cut),
    reason: 'The Antigravity app is waiting for an answer to a permission prompt.',
  };
}

// The structured result is the last fenced JSON block of the reply; only the
// top level of the schema (type object, required keys) is checked.
export function structuredFromReply(reply, schema) {
  // Fences are read line by line, so each opening fence pairs with its own close.
  const blocks = [];
  let open = null;
  for (const line of String(reply ?? '').split('\n')) {
    const fence = /^\s*```\s*([\w-]*)\s*$/.exec(line);
    if (open === null) {
      if (fence) open = { language: fence[1].toLowerCase(), lines: [] };
    } else if (fence && !fence[1]) {
      blocks.push(open);
      open = null;
    } else {
      open.lines.push(line);
    }
  }
  const json = blocks.filter((block) => block.language === 'json' || block.language === '');
  if (json.length === 0) throw new Error('The reply has no fenced JSON block for --json-schema.');
  let value;
  try {
    value = JSON.parse(json.at(-1).lines.join('\n'));
  } catch {
    throw new Error('The last fenced block of the reply is not valid JSON.');
  }
  if (schema.type === 'object' && (value === null || typeof value !== 'object' || Array.isArray(value))) throw new Error('The JSON block is not an object.');
  const missing = (schema.required ?? []).filter((key) => !(key in value));
  if (missing.length > 0) throw new Error(`The JSON block lacks ${missing.join(', ')}.`);
  return value;
}

// Each side is { head, hashes: { file: content hash } } over the files git
// reports as changed or untracked; a file differs when its hash does.
export function changedFiles(before, after) {
  const files = new Set([...Object.keys(before.hashes), ...Object.keys(after.hashes)]);
  return [...files].filter((file) => before.hashes[file] !== after.hashes[file]).sort();
}

// Added and removed lines per file, from a working-tree diff against HEAD (as
// collectScope writes it, new files included), for the files the run changed.
export function diffStat(diff, files) {
  const counts = new Map();
  let current = null;
  let fresh = false;
  let lastPlus = false;
  const close = () => {
    if (current && fresh && lastPlus) current.added -= 1;
  };
  for (const line of String(diff ?? '').split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line) ?? /^--- new file (.+?)(?: \(.*\))?$/.exec(line);
    if (header) {
      close();
      const file = header[2] ?? header[1];
      current = { file, added: 0, removed: 0 };
      counts.set(file, current);
      fresh = line.startsWith('--- new file');
      lastPlus = false;
      continue;
    }
    if (!current || line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    lastPlus = line === '+';
    if (line.startsWith('+')) current.added += 1;
    else if (line.startsWith('-')) current.removed += 1;
  }
  close();
  return files.filter((file) => counts.has(file)).map((file) => counts.get(file));
}

export function envelope({ status, category, response = null, structured = null, requests = [], warnings = [], evidence }) {
  return {
    schema_version: 1,
    status,
    category: category ?? null,
    conversation_id: null,
    response,
    structured_output: structured,
    tool_calls: [],
    subagents: [],
    permission_requests: requests,
    artifacts: [],
    warnings,
    usage: null,
    evidence: { transport: 'desktop', ...evidence },
  };
}
