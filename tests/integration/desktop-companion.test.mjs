import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { companionEnv, runCompanion } from './helpers.mjs';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-desktop-bridge.mjs');
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
  return { cwd, env, fake, set, choose, companion, calls: () => (fake().calls ?? []).map((call) => call.join(' ')) };
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
  for (let waited = 0; !context.calls().includes('send'); waited += 100) {
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
  for (let waited = 0; !context.calls().includes('send'); waited += 100) {
    assert.ok(waited < 15_000, 'the job never sent its prompt');
    await new Promise((done) => setTimeout(done, 100));
  }
  const cancelled = json(await context.companion(['cancel', started.job.id, '--json']));
  assert.equal(cancelled.stopped, true);
  assert.equal(context.fake().stopped, true);
  assert.equal(context.fake().clipboard, 'user clipboard');
  assert.equal(context.fake().frontmost, 'com.example.host');
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
  assert.deepEqual(other.calls().filter((call) => call.startsWith('answer')), ['answer Skip  Fake Task - ws - Antigravity']);
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
