import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

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
  assert.deepEqual(envelope.evidence, { transport: 'desktop', app_version: '2.35.2', preset: 'Request Review', session_resumed: false, changed_files: [] });
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
    assert.notEqual(code, 0);
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
  const { envelope } = await run(context);
  assert.equal(envelope.status, 'error');
  assert.ok(names(context).includes('clear-input'));
  assert.ok(!names(context).includes('send'));
  assertCleanedUp(context);
});

test('SIGTERM stops the run in the app and cleans up', { skip: process.platform === 'win32' }, async () => {
  const context = setup({ stuck: true });
  const { child, done } = start(context);
  while (!names(context).includes('send')) await new Promise((resolve) => setTimeout(resolve, 20));
  child.kill('SIGTERM');
  const { envelope } = await done;
  assert.equal(envelope.status, 'error');
  assert.ok(names(context).includes('stop'));
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
