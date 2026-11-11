import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { companionEnv, runCompanion } from './helpers.mjs';
import { buildReviewRequest } from '../../scripts/companion.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function repository({ dirty = true } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-review-'));
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'Test');
  writeFileSync(join(cwd, 'a.txt'), 'one\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', 'base');
  if (dirty) writeFileSync(join(cwd, 'a.txt'), 'one\nCASE_REVIEW marker\n');
  return cwd;
}

test('review of a clean tree on its base runs nothing', async () => {
  const run = await runCompanion(['review', '--json'], { cwd: repository({ dirty: false }) });
  assert.equal(run.code, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.job, null);
  assert.match(result.message, /Nothing to review/);
});

test('review hands the diff to agy and renders its findings without touching the tree', async () => {
  const cwd = repository();
  const before = git(cwd, 'status', '--porcelain');
  const run = await runCompanion(['review'], { cwd });
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /\*\*MEDIUM\*\* Saw the diff/);
  assert.match(run.stdout, /diff delivered/);
  assert.match(run.stdout, /standard pass/);
  assert.equal(git(cwd, 'status', '--porcelain'), before);
});

test('adversarial review uses its own prompt', async () => {
  const run = await runCompanion(['adversarial-review', '--json'], { cwd: repository() });
  assert.equal(run.code, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.job.kind, 'adversarial-review');
  assert.equal(result.envelope.structured_output.summary, 'adversarial pass');
});

test('a background review returns a job id at once', async () => {
  const env = companionEnv();
  const cwd = repository();
  const run = await runCompanion(['review', '--background', '--json'], { env, cwd });
  assert.equal(run.code, 0, run.stderr);
  assert.match(JSON.parse(run.stdout).job.id, /^job-/);
});

test('reviews keep their own conversations, apart from the workspace task session', () => {
  const request = buildReviewRequest({
    kind: 'review',
    scope: { kind: 'working-tree', base: null, files: ['a.txt'], diff: '+x', truncated: false },
    options: {},
  });
  // Same state folder as tasks, so grant locks and recovery stay shared;
  // --no-record keeps the review from replacing the task session.
  assert.equal(request.stateDir, undefined);
  assert.ok(request.runnerArgs.includes('--new-session'));
  assert.ok(request.runnerArgs.includes('--no-record'));
  assert.equal(request.mode, 'read');
  assert.ok(request.runnerArgs.includes('--json-schema'));
});

test('--wait runs in the foreground and cannot be combined with --background', async () => {
  const cwd = repository();
  const waited = await runCompanion(['review', '--wait'], { cwd });
  assert.equal(waited.code, 0, waited.stderr);
  assert.match(waited.stdout, /Saw the diff/);
  const both = await runCompanion(['review', '--wait', '--background'], { cwd });
  assert.notEqual(both.code, 0);
});

test('review refuses write mode and grants', async () => {
  const run = await runCompanion(['review', '--write'], { cwd: repository() });
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /Unknown option: --write/);
});

test('a file named like a placeholder never moves the diff out of its block', () => {
  const request = buildReviewRequest({
    kind: 'review',
    scope: { kind: 'working-tree', base: null, files: ['{{DIFF}}', '{{TARGET}}'], diff: '+REAL-DIFF-CONTENT', truncated: false },
    options: {},
    focus: '{{FILES}}',
  });
  const inside = request.prompt.split('<agybird_review_diff>')[1].split('</agybird_review_diff>')[0];
  assert.match(inside, /REAL-DIFF-CONTENT/);
  assert.equal(request.prompt.split('REAL-DIFF-CONTENT').length, 2, 'the diff appears exactly once');
  assert.match(request.prompt, /<agybird_changed_files>[\s\S]*\{\{DIFF\}\}[\s\S]*<\/agybird_changed_files>/);
});
