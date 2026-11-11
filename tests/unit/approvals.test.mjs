import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { approvedRules } from '../../scripts/companion.mjs';
import { newJobId, writeJob } from '../../scripts/lib/jobs.mjs';

function blockedJob(directory, conversation, rule = 'command(ls)') {
  const id = newJobId();
  writeJob(directory, { id, kind: 'task', status: 'completed', model: 'gemini-3.8-flash-high', createdAt: new Date().toISOString(), request: { category: 'code', mode: 'write' } });
  writeFileSync(join(directory, `${id}.result.json`), JSON.stringify({ conversation_id: conversation, permission_requests: [{ tool: 'run_command', target: 'ls', suggested_rule: rule, grantable: true }] }));
  return id;
}

test('approvals bind to the conversation that asked', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agybird-approvals-'));
  const id = blockedJob(directory, 'conv-a');
  assert.deepEqual(approvedRules(directory, [`${id}:0`]), { rules: ['command(ls)'], conversation: 'conv-a', mode: 'write', category: 'code', model: 'gemini-3.8-flash-high', references: [] });
});

test('approvals from two conversations are refused together', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agybird-approvals-'));
  const first = blockedJob(directory, 'conv-a');
  const second = blockedJob(directory, 'conv-b', 'command(pwd)');
  assert.throws(() => approvedRules(directory, [`${first}:0`, `${second}:0`]), /different conversations/);
});

test('a job without a conversation id cannot be approved', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agybird-approvals-'));
  const id = blockedJob(directory, null);
  assert.throws(() => approvedRules(directory, [`${id}:0`]), /no conversation/);
});

test('an image job keeps its category, so the retry still verifies the image', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agybird-approvals-'));
  const id = newJobId();
  writeJob(directory, { id, kind: 'image', status: 'completed', createdAt: new Date().toISOString(), request: { category: 'image', mode: 'write' } });
  writeFileSync(join(directory, `${id}.result.json`), JSON.stringify({ conversation_id: 'conv-i', permission_requests: [{ tool: 'run_command', target: 'ls', suggested_rule: 'command(ls)', grantable: true }] }));
  assert.equal(approvedRules(directory, [`${id}:0`]).category, 'image');
});

test('an image edit keeps its reference images through an approval', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agybird-approvals-'));
  const id = newJobId();
  writeJob(directory, { id, kind: 'image', status: 'completed', createdAt: new Date().toISOString(), request: { category: 'image', mode: 'write', runnerArgs: ['--reference', '/photos/a.png', '--reference', '/photos/b.png'] } });
  writeFileSync(join(directory, `${id}.result.json`), JSON.stringify({ conversation_id: 'conv-i', permission_requests: [{ tool: 'run_command', target: 'ls', suggested_rule: 'command(ls)', grantable: true }] }));
  assert.deepEqual(approvedRules(directory, [`${id}:0`]).references, ['/photos/a.png', '/photos/b.png']);
});

test('a review or gate job cannot be approved, so its standalone conversation never replaces the task session', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agybird-approvals-'));
  for (const kind of ['review', 'adversarial-review', 'stop-review']) {
    const id = newJobId();
    writeJob(directory, { id, kind, status: 'completed', createdAt: new Date().toISOString(), request: { category: 'code', mode: 'read' } });
    writeFileSync(join(directory, `${id}.result.json`), JSON.stringify({ conversation_id: 'conv-r', permission_requests: [{ tool: 'read_file', target: '/x', suggested_rule: 'read_file(/x)', grantable: true }] }));
    assert.throws(() => approvedRules(directory, [`${id}:0`]), /only a task or image job/);
  }
});
