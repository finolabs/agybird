import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { cancelWaitMs } from '../../scripts/companion.mjs';
import { companionEnv, runCompanion } from './helpers.mjs';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-desktop-bridge.mjs');
const COMPANION = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'companion.mjs');
const DIALOG = { question: 'Allow list directory contents?', options: ['1 Yes, allow this time', "2 Yes, and always allow 'ls' in this conversation", "3 Yes, and always allow 'ls'", '4 No (tell the agent what to do instead)'] };

function git(cwd, ...args) {
  assert.equal(spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd }).status, 0);
}

// A git workspace that Antigravity knows as project "ws", and a fake app.
function workspace(state = {}) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agybird-dc-ws-')));
  git(cwd, 'init', '-q');
  writeFileSync(join(cwd, 'a.txt'), 'one\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', 'init');
  const env = companionEnv({ AGYBIRD_DESKTOP_BRIDGE: FAKE, AGYBIRD_DESKTOP_POLL_MS: '10' });
  writeFileSync(join(env.AGYBIRD_PROJECTS_DIR, 'p.json'), JSON.stringify({ id: 'p', name: 'ws', projectResources: { resources: [{ gitFolder: { folderUri: pathToFileURL(cwd).href } }] } }));
  env.AGYBIRD_FAKE_DESKTOP_STATE = join(mkdtempSync(join(tmpdir(), 'agybird-dc-fake-')), 'state.json');
  writeFileSync(env.AGYBIRD_FAKE_DESKTOP_STATE, JSON.stringify(state));
  const fake = () => JSON.parse(readFileSync(env.AGYBIRD_FAKE_DESKTOP_STATE, 'utf8'));
  const set = (patch) => writeFileSync(env.AGYBIRD_FAKE_DESKTOP_STATE, JSON.stringify({ ...fake(), ...patch }));
  const companion = (args, input = '') => runCompanion(args, { env, cwd, input });
  // Chosen globally, as setup --transport would on macOS, so the tests run everywhere.
  const choose = (transport) => writeFileSync(join(env.AGYBIRD_JOBS_DIR, 'config.json'), JSON.stringify({ transport }));
  const calls = () => (fake().calls ?? []).map((call) => call.join(' '));
  return { cwd, env, fake, set, choose, companion, calls, sent: () => calls().some((call) => call.startsWith('send')) };
}

function json(result) {
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('with no transport chosen a task runs on the CLI exactly as before', async () => {
  const context = workspace();
  const { job, envelope } = json(await context.companion(['task', '--json', 'Say hi']));
  assert.equal('transport' in job, false);
  assert.equal(envelope.evidence.transport, undefined);
  assert.equal(context.fake().calls, undefined, 'the app was never touched');
});

test('with desktop chosen a task runs in the app, without a model pick', async () => {
  const context = workspace({ reply: 'hi from the app' });
  context.choose('desktop');
  const { job, envelope } = json(await context.companion(['task', '--json', 'Say hi']));
  assert.equal(job.transport, 'desktop');
  assert.equal(job.model, null);
  assert.equal(envelope.status, 'success', JSON.stringify(envelope.warnings));
  assert.equal(envelope.response, 'hi from the app');
  assert.ok(context.calls().includes('new-conversation ws'));
});

test('--via picks the transport for one call either way', async () => {
  const context = workspace();
  assert.equal(json(await context.companion(['task', '--via', 'desktop', '--json', 'Say hi'])).envelope.evidence.transport, 'desktop');
  context.choose('desktop');
  assert.equal(json(await context.companion(['task', '--via', 'cli', '--json', 'Say hi'])).envelope.evidence.transport, undefined);
});

test('a model or an effort is refused on the desktop transport', async () => {
  const context = workspace();
  for (const flags of [['--model', 'x'], ['--effort', 'high']]) {
    const run = await context.companion(['task', '--via', 'desktop', ...flags, 'Say hi']);
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, new RegExp(`${flags[0]}.*desktop`));
  }
  assert.equal(context.fake().calls, undefined);
});

test('a review on the desktop transport parses the findings block of the reply', async () => {
  const review = { verdict: 'approve', summary: 'Fine.', findings: [], next_steps: [] };
  const context = workspace({ reply: `Done.\n\`\`\`json\n${JSON.stringify(review)}\n\`\`\`` });
  writeFileSync(join(context.cwd, 'a.txt'), 'two\n');
  const { job, envelope } = json(await context.companion(['review', '--via', 'desktop', '--json']));
  assert.equal(job.transport, 'desktop');
  assert.equal(envelope.status, 'success', JSON.stringify(envelope.warnings));
  assert.deepEqual(envelope.structured_output, review);
});

test('an approved desktop request presses "allow this time" once in the waiting conversation', async () => {
  const context = workspace({ dialog: DIALOG, runningPolls: 0, reply: 'listed' });
  const first = json(await context.companion(['task', '--via', 'desktop', '--json', 'List the files']));
  assert.equal(first.envelope.status, 'needs_permission');
  const { requests } = json(await context.companion(['permissions', first.job.id, '--json']));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].question, DIALOG.question);
  assert.equal(requests[0].approvable, true);
  const before = context.calls().length;

  const second = json(await context.companion(['task', '--approve', requests[0].approval, '--json']));
  assert.equal(second.envelope.status, 'success', JSON.stringify(second.envelope.warnings));
  assert.equal(second.envelope.response, 'listed');
  const later = context.calls().slice(before);
  assert.deepEqual(later.filter((call) => call.startsWith('answer')), [`answer 1 ${DIALOG.question} Fake Task - ws - Antigravity`]);
  assert.ok(!later.some((call) => /^(new-conversation|send|paste-input)/.test(call)));
});

test('an approval is refused when the app now asks something else, or with a grant scope', async () => {
  const context = workspace({ dialog: DIALOG });
  const first = json(await context.companion(['task', '--via', 'desktop', '--json', 'List the files']));
  const approval = `${first.job.id}:0`;
  const scoped = await context.companion(['task', '--approve', approval, '--grant-scope', 'remember']);
  assert.notEqual(scoped.code, 0);
  assert.match(scoped.stderr, /grant-scope/);

  context.set({ dialog: { ...DIALOG, question: 'Allow running rm -rf?' } });
  const changed = await context.companion(['task', '--approve', approval, '--json']);
  assert.equal(JSON.parse(changed.stdout).envelope.status, 'error');
  assert.match(JSON.parse(changed.stdout).envelope.warnings.join(' '), /no longer asks/);
  assert.ok(!context.calls().some((call) => call.startsWith('answer')));
});

test('a question too long to show whole, or a job with no conversation title, is not approvable', async () => {
  const long = `Allow running ${'x'.repeat(4_100)} tail`;
  const context = workspace({ dialog: { ...DIALOG, question: long } });
  const first = json(await context.companion(['task', '--via', 'desktop', '--json', 'List the files']));
  assert.equal(first.envelope.status, 'needs_permission');
  const { requests } = json(await context.companion(['permissions', first.job.id, '--json']));
  assert.equal(requests[0].question_truncated, true);
  assert.equal(requests[0].approvable, false);
  assert.match((await context.companion(['permissions', first.job.id])).stdout, /shortened/);
  const refused = await context.companion(['task', '--approve', requests[0].approval, '--json']);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /too long/);
  assert.ok(!context.calls().some((call) => call.startsWith('answer')));

  const untitled = workspace({ dialog: DIALOG });
  const asked = json(await untitled.companion(['task', '--via', 'desktop', '--json', 'List the files']));
  const store = readdirSync(untitled.env.AGYBIRD_JOBS_DIR).map((name) => join(untitled.env.AGYBIRD_JOBS_DIR, name)).find((path) => !path.endsWith('.json'));
  const resultFile = join(store, `${asked.job.id}.result.json`);
  const stored = JSON.parse(readFileSync(resultFile, 'utf8'));
  delete stored.evidence.conversation_title;
  writeFileSync(resultFile, JSON.stringify(stored));
  assert.equal(json(await untitled.companion(['permissions', asked.job.id, '--json'])).requests[0].approvable, false);
});

test('image work stays on the CLI when desktop is chosen', async () => {
  const context = workspace();
  context.choose('desktop');
  const run = await context.companion(['image', '--json', 'a red square']);
  assert.match(run.stderr, /image.*CLI/i);
  assert.equal(context.fake().calls, undefined);
});

test('cancelling a desktop job presses Stop execution in the app', { skip: process.platform === 'win32' }, async () => {
  const context = workspace({ stuck: true });
  const started = json(await context.companion(['task', '--via', 'desktop', '--background', '--json', 'Run forever']));
  for (let waited = 0; !context.sent(); waited += 100) {
    assert.ok(waited < 15_000, 'the job never sent its prompt');
    await new Promise((done) => setTimeout(done, 100));
  }
  const cancelled = json(await context.companion(['cancel', started.job.id, '--json']));
  assert.equal(cancelled.stopped, true);
  assert.ok(context.calls().some((call) => call.startsWith('stop')));
  assert.equal(context.fake().clipboard, 'user clipboard');
});

test('approving a CLI job stays on the CLI when desktop is chosen meanwhile', async () => {
  const context = workspace();
  const blocked = await context.companion(['task', '--json', 'CASE_FORGED_AUTH']);
  const job = JSON.parse(blocked.stdout).job;
  context.choose('desktop');
  const approved = await context.companion(['task', '--json', '--approve', `${job.id}:0`]);
  assert.equal(approved.code, 0, approved.stderr);
  const next = JSON.parse(approved.stdout).job;
  assert.equal(next.transport, undefined);
  const store = readdirSync(context.env.AGYBIRD_JOBS_DIR).map((name) => join(context.env.AGYBIRD_JOBS_DIR, name)).find((path) => !path.endsWith('.json'));
  const record = JSON.parse(readFileSync(join(store, `${next.id}.json`), 'utf8'));
  assert.ok(record.request.runnerArgs.includes('--grant'));
  assert.ok(record.request.runnerArgs.includes('--conversation'));
  assert.equal(context.fake().calls, undefined, 'the app was never touched');
});

test('cancel leaves a desktop run time to stop the app and put the clipboard back', { skip: process.platform === 'win32' }, async () => {
  const context = workspace({ stuck: true, delays: { stop: 4_000 } });
  const started = json(await context.companion(['task', '--via', 'desktop', '--background', '--json', 'Run forever']));
  for (let waited = 0; !context.sent(); waited += 100) {
    assert.ok(waited < 15_000, 'the job never sent its prompt');
    await new Promise((done) => setTimeout(done, 100));
  }
  const cancelled = json(await context.companion(['cancel', started.job.id, '--json']));
  assert.equal(cancelled.stopped, true);
  assert.equal(context.fake().stopped, true);
  assert.equal(context.fake().clipboard, 'user clipboard');
  assert.equal(context.fake().frontmost, 'com.example.host');
});

const waitForCall = async (context, prefix) => {
  for (let waited = 0; !context.calls().some((call) => call.startsWith(prefix)); waited += 100) {
    assert.ok(waited < 15_000, `the job never called ${prefix}`);
    await new Promise((done) => setTimeout(done, 100));
  }
};

test('cancel during a long paste clears the composer, restores the clipboard and releases the lock', { skip: process.platform === 'win32' }, async () => {
  const context = workspace({ delays: { 'paste-input': 60_000 } });
  const started = json(await context.companion(['task', '--via', 'desktop', '--background', '--json', 'A long review']));
  await waitForCall(context, 'paste-input');
  const cancelled = json(await context.companion(['cancel', started.job.id, '--json']));
  assert.equal(cancelled.stopped, true);
  assert.equal(context.fake().clipboard, 'user clipboard');
  assert.equal(context.fake().frontmost, 'com.example.host');
  assert.equal(context.fake().cleared, true);
  assert.equal(existsSync(join(context.env.AGYBIRD_STATE_DIR, 'desktop.lock')), false);
  assert.ok(!context.sent());
});

test('a signal to a foreground desktop task gives the runner its grace to stop the app and restore', { skip: process.platform === 'win32' }, async () => {
  const context = workspace({ stuck: true, delays: { stop: 4_000 } });
  const child = spawn(process.execPath, [COMPANION, 'task', '--via', 'desktop', '--json', 'Run forever'], { cwd: context.cwd, env: context.env, stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.end();
  const exited = new Promise((done) => child.on('close', (code, signal) => done({ code, signal })));
  await waitForCall(context, 'send');
  child.kill('SIGTERM');
  const { code } = await exited;
  assert.equal(code, 143);
  assert.equal(context.fake().stopped, true);
  assert.equal(context.fake().clipboard, 'user clipboard');
  assert.equal(context.fake().frontmost, 'com.example.host');
  assert.equal(existsSync(join(context.env.AGYBIRD_STATE_DIR, 'desktop.lock')), false);
});

test('cancel waits long enough for a desktop runner to use its whole grace', () => {
  // SIGTERM at the next worker poll (1 s), 12 s of grace, then killTree's own 3 s.
  assert.ok(cancelWaitMs({ request: { transport: 'desktop' } }) > 16_000);
  assert.equal(cancelWaitMs({ request: {} }), 15_000);
});

test('an approval whose run is blocked before it presses the answer can be retried', async () => {
  const context = workspace({ dialog: DIALOG, reply: 'listed' });
  const first = json(await context.companion(['task', '--via', 'desktop', '--json', 'List the files']));
  const approval = `${first.job.id}:0`;
  const lock = join(context.env.AGYBIRD_STATE_DIR, 'desktop.lock');
  writeFileSync(lock, String(process.pid));
  const blocked = json(await context.companion(['task', '--approve', approval, '--json']));
  assert.equal(blocked.envelope.evidence.blocked_reason, 'locked');
  assert.equal(blocked.envelope.evidence.answered, undefined);
  rmSync(lock);
  const retried = json(await context.companion(['task', '--approve', approval, '--json']));
  assert.equal(retried.envelope.status, 'success', JSON.stringify(retried.envelope.warnings));
  assert.equal(retried.envelope.evidence.answered, '1');
  assert.equal(context.calls().filter((call) => call.startsWith('answer')).length, 1);
  const again = await context.companion(['task', '--approve', approval, '--json']);
  assert.match(again.stderr, /already answered/);
});

test('a desktop request is approved once, and can be declined instead', async () => {
  const context = workspace({ dialog: DIALOG, reply: 'listed' });
  const first = json(await context.companion(['task', '--via', 'desktop', '--json', 'List the files']));
  const approval = `${first.job.id}:0`;
  json(await context.companion(['task', '--approve', approval, '--json']));
  const again = await context.companion(['task', '--approve', approval, '--json']);
  assert.notEqual(again.code, 0);
  assert.match(again.stderr, /already answered/);

  const other = workspace({ dialog: DIALOG, reply: 'declined' });
  const asked = json(await other.companion(['task', '--via', 'desktop', '--json', 'List the files']));
  const declined = json(await other.companion(['task', '--decline', `${asked.job.id}:0`, '--json']));
  assert.equal(declined.envelope.status, 'success');
  assert.doesNotMatch(declined.job.title, /granted/);
  assert.deepEqual(other.calls().filter((call) => call.startsWith('answer')), [`answer Skip ${DIALOG.question} Fake Task - ws - Antigravity`]);
  const cli = workspace();
  const blocked = JSON.parse((await cli.companion(['task', '--json', 'CASE_FORGED_AUTH'])).stdout).job;
  const refused = await cli.companion(['task', '--decline', `${blocked.id}:0`]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /desktop/);
});

test('setup still reports when the transport config holds an unknown value', async () => {
  const context = workspace();
  context.choose('gui');
  const report = json(await context.companion(['setup', '--json']));
  assert.equal(report.transportSource, 'invalid');
  assert.ok(report.problems.some((problem) => /gui/.test(problem)));
});
