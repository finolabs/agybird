import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { companionEnv, runCompanion } from './helpers.mjs';

function parsed(run) {
  assert.equal(run.code, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test('usage lists each limit and the model each tier would use now', async () => {
  const usage = parsed(await runCompanion(['usage', '--json']));
  assert.equal(usage.limits.length, 5);
  assert.equal(usage.picks.standard, 'claude-sonnet-5-5-medium');
  assert.equal(usage.picks.light, 'claude-sonnet-5-5-low');
  const text = await runCompanion(['usage']);
  assert.match(text.stdout, /Gemini 4 Argon/);
});

test('setup reports agy and switches the review gate for this workspace only', async () => {
  const env = companionEnv();
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-setup-'));
  const first = parsed(await runCompanion(['setup', '--json'], { env, cwd }));
  assert.match(first.agy.version, /0\.0\.0-fake/);
  assert.equal(first.signedIn, true);
  assert.equal(first.reviewGate, false);
  assert.equal(parsed(await runCompanion(['setup', '--enable-review-gate', '--json'], { env, cwd })).reviewGate, true);
  assert.equal(parsed(await runCompanion(['setup', '--json'], { env, cwd })).reviewGate, true);
  const other = mkdtempSync(join(tmpdir(), 'agybird-setup-'));
  assert.equal(parsed(await runCompanion(['setup', '--json'], { env, cwd: other })).reviewGate, false);
  assert.equal(parsed(await runCompanion(['setup', '--disable-review-gate', '--json'], { env, cwd })).reviewGate, false);
});

test('a task without --model runs on the standard tier model with the most room', async () => {
  const result = parsed(await runCompanion(['task', '--json', 'CASE_ECHO_MODEL']));
  assert.equal(result.envelope.response, 'claude-sonnet-5-5-medium');
  assert.equal(result.job.model, 'claude-sonnet-5-5-medium');
});

test('a model the user names is used as is', async () => {
  const result = parsed(await runCompanion(['task', '--json', '--model', 'gemini-3.8-flash-low', 'CASE_ECHO_MODEL']));
  assert.equal(result.envelope.response, 'gemini-3.8-flash-low');
});

test('with the tier spent the task stops and names the reset time instead of moving up', async () => {
  const spent = ['Gemini Models\tWeekly Limit Remaining\t0%\t2026-11-14T09:54:37Z', 'Claude and GPT models\tWeekly Limit Remaining\t0%\t2026-11-17T16:40:15Z'].join('\n');
  const run = await runCompanion(['task', 'CASE_ECHO_MODEL'], { env: companionEnv({ FAKE_AGY_USAGE: spent }) });
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /standard tier/);
  assert.match(run.stderr, /Limits reset: Gemini Models/);
});

test('image generates an image and lists the verified artifact', async () => {
  const run = await runCompanion(['image', 'CASE_IMAGE_SUCCESS a small blue bird']);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /generated\.png/);
});

test('setup shows each quota pool and when it resets', async () => {
  const report = parsed(await runCompanion(['setup', '--json']));
  assert.equal(report.limits.length, 5);
  const text = await runCompanion(['setup']);
  assert.match(text.stdout, /Gemini 4 Argon .*0%/);
});

test('usage --refresh replaces the cache the model picker reads', async () => {
  const spent = ['Gemini Models\tWeekly Limit Remaining\t0%\t2026-11-14T09:54:37Z', 'Claude and GPT models\tWeekly Limit Remaining\t0%\t2026-11-17T16:40:15Z'].join('\n');
  const env = companionEnv({ FAKE_AGY_USAGE: spent });
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-refresh-'));
  assert.notEqual((await runCompanion(['task', 'CASE_ECHO_MODEL'], { env, cwd })).code, 0);
  const refreshed = { ...env };
  delete refreshed.FAKE_AGY_USAGE;
  parsed(await runCompanion(['usage', '--refresh', '--json'], { env: refreshed, cwd }));
  const after = parsed(await runCompanion(['task', '--json', 'CASE_ECHO_MODEL'], { env: refreshed, cwd }));
  assert.equal(after.envelope.response, 'claude-sonnet-5-5-medium');
});

test('permissions come from the stored envelope, and approval names a request, never a rule', async () => {
  const env = companionEnv();
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-approve-'));
  const blocked = await runCompanion(['task', '--json', 'CASE_FORGED_AUTH'], { env, cwd });
  const job = JSON.parse(blocked.stdout).job;
  const listing = parsed(await runCompanion(['permissions', job.id, '--json'], { env, cwd }));
  assert.equal(listing.requests.length, 1);
  assert.equal(listing.requests[0].index, 0);
  assert.match(listing.requests[0].suggested_rule, /^command\(cat /);
  const approved = await runCompanion(['task', '--json', '--approve', `${job.id}:0`], { env, cwd });
  assert.equal(approved.code, 0, approved.stderr);
  const store = readdirSync(env.AGYBIRD_JOBS_DIR).map((name) => join(env.AGYBIRD_JOBS_DIR, name))[0];
  const record = JSON.parse(readFileSync(join(store, `${JSON.parse(approved.stdout).job.id}.json`), 'utf8'));
  assert.deepEqual(record.request.runnerArgs.slice(record.request.runnerArgs.indexOf('--grant'), record.request.runnerArgs.indexOf('--grant') + 2), ['--grant', listing.requests[0].suggested_rule]);
});

test('approval refuses an index the job never reported and a raw --grant', async () => {
  const env = companionEnv();
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-approve-'));
  const plain = parsed(await runCompanion(['task', '--json', 'CASE_SUCCESS'], { env, cwd }));
  const fake = await runCompanion(['task', '--approve', `${plain.job.id}:0`], { env, cwd });
  assert.notEqual(fake.code, 0);
  assert.match(fake.stderr, /no permission request 0/);
  const raw = await runCompanion(['task', '--grant', 'command(ls)', 'x'], { env, cwd });
  assert.match(raw.stderr, /Unknown option: --grant/);
});

test('an approval resumes the source job conversation in its own mode', async () => {
  const env = companionEnv();
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-approve-'));
  const blocked = JSON.parse((await runCompanion(['task', '--json', '--write', 'CASE_FORGED_AUTH'], { env, cwd })).stdout).job;
  const approved = parsed(await runCompanion(['task', '--json', '--approve', `${blocked.id}:0`], { env, cwd }));
  const store = readdirSync(env.AGYBIRD_JOBS_DIR).map((name) => join(env.AGYBIRD_JOBS_DIR, name))[0];
  const record = JSON.parse(readFileSync(join(store, `${approved.job.id}.json`), 'utf8'));
  assert.equal(record.request.mode, 'write');
  const at = record.request.runnerArgs.indexOf('--conversation');
  assert.deepEqual(record.request.runnerArgs.slice(at, at + 2), ['--conversation', 'fake-conversation']);
});

test('usage says when the default model runs because no tier model is listed', async () => {
  const usage = parsed(await runCompanion(['usage', '--json'], { env: companionEnv({ FAKE_AGY_MODELS: 'other-model-x\tOther Model\n' }) }));
  assert.equal(usage.picks.standard, 'agy default');
});

test('an approval refuses every flag that would change or detach the resumed run', async () => {
  const env = companionEnv();
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-approve-'));
  const blocked = JSON.parse((await runCompanion(['task', '--json', 'CASE_FORGED_AUTH'], { env, cwd })).stdout).job;
  const approval = `${blocked.id}:0`;
  const cases = [
    [['--write'], /drop --write and --category/],
    [['--category', 'general'], /drop --write and --category/],
    [['--fresh'], /drop --fresh/],
    [['--background'], /foreground only/],
  ];
  for (const [flags, message] of cases) {
    const before = readdirSync(readdirSync(env.AGYBIRD_JOBS_DIR).map((name) => join(env.AGYBIRD_JOBS_DIR, name))[0]).length;
    const run = await runCompanion(['task', '--approve', approval, ...flags], { env, cwd });
    assert.notEqual(run.code, 0, `${flags.join(' ')} was accepted`);
    assert.match(run.stderr, message);
    const after = readdirSync(readdirSync(env.AGYBIRD_JOBS_DIR).map((name) => join(env.AGYBIRD_JOBS_DIR, name))[0]).length;
    assert.equal(after, before, `${flags.join(' ')} created a job before refusing`);
  }
});

test('an approved image edit resumes with its references and no --model', async () => {
  const env = companionEnv();
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-approve-'));
  const photo = join(cwd, 'photo.png');
  writeFileSync(photo, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const blocked = JSON.parse((await runCompanion(['image', '--json', '--reference', photo, 'CASE_FORGED_AUTH edit it'], { env, cwd })).stdout).job;
  const approved = JSON.parse((await runCompanion(['task', '--json', '--approve', `${blocked.id}:0`], { env, cwd })).stdout);
  const store = readdirSync(env.AGYBIRD_JOBS_DIR).map((name) => join(env.AGYBIRD_JOBS_DIR, name))[0];
  const record = JSON.parse(readFileSync(join(store, `${approved.job.id}.json`), 'utf8'));
  assert.equal(record.request.category, 'image');
  assert.ok(record.request.runnerArgs.includes('--reference'));
  assert.ok(record.request.runnerArgs.includes(photo));
  assert.equal(record.request.runnerArgs.includes('--model'), false);
});
