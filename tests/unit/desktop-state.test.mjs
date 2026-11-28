import assert from 'node:assert/strict';
import test from 'node:test';

import { changedFiles, checkProbe, permissionRequest, presetWarnings, structuredFromReply } from '../../scripts/lib/desktop-state.mjs';

const probe = { trusted: true, pid: 1, version: '2.35.2', frontmost: 'x' };

test('preflight blocks outside macOS, without the app, without trust or on an untested version', () => {
  const reason = (value, options = {}) => {
    try {
      checkProbe(value, { platform: 'darwin', allowVersion: false, ...options });
      return null;
    } catch (error) {
      return error.reason;
    }
  };
  assert.equal(reason(probe), null);
  assert.equal(reason(probe, { platform: 'linux' }), 'not_macos');
  assert.equal(reason(probe, { platform: 'win32' }), 'not_macos');
  assert.equal(reason({ ...probe, pid: null }), 'app_missing');
  assert.equal(reason({ ...probe, trusted: false }), 'not_trusted');
  assert.equal(reason({ ...probe, version: '2.36.0' }), null);
  assert.equal(reason({ ...probe, version: '2.36.12' }), null);
  for (const version of ['2.37.0', '2.3.6', '2.34.9', '12.36.0', null]) assert.equal(reason({ ...probe, version }), 'unsupported_version', String(version));
  assert.equal(reason({ ...probe, version: '2.37.0' }, { allowVersion: true }), null);
});

test('only Auto and Turbo warn about unattended commands', () => {
  assert.deepEqual(['Request Review', 'Default', null].map((preset) => presetWarnings(preset).length), [0, 0, 0]);
  assert.match(presetWarnings('Turbo')[0], /without asking/);
  assert.match(presetWarnings('Auto')[0], /without asking/);
});

test('a dialog becomes a request with its question, rule scope and options, never grantable', () => {
  const request = permissionRequest({ question: `Allow ${'x'.repeat(400)}?`, options: ['1 Yes, allow this time', "2 Yes, and always allow 'ls' in this conversation"] });
  assert.equal(request.scope, 'ls');
  assert.equal(request.grantable, false);
  assert.equal(request.target_truncated, true);
  assert.ok(request.target.length <= 301);
  // The question the user is shown before approving is the whole one.
  assert.equal(request.question, `Allow ${'x'.repeat(400)}?`);
  assert.equal(request.question_truncated, false);
  assert.equal(permissionRequest({ question: 'Allow\n  ls?', options: [] }).target_truncated, false);
  assert.equal(request.question_full, `Allow ${'x'.repeat(400)}?`);
});

test('a question too long to show whole is marked truncated and still kept whole for the match', () => {
  const long = `Allow ${'x'.repeat(4_100)} tail`;
  const request = permissionRequest({ question: long, options: [] });
  assert.equal(request.question_truncated, true);
  assert.equal(request.question_full, long);
  assert.ok(request.question.length <= 4_001);
});

test('the structured output is the last fenced JSON block and must hold the required keys', () => {
  const schema = { type: 'object', required: ['a'] };
  assert.deepEqual(structuredFromReply('```json\n{"a":0}\n```\ntext\n```json\n{"a":1}\n```', schema), { a: 1 });
  assert.throws(() => structuredFromReply('none', schema), /no fenced JSON/);
  // An earlier code block of another language must not pair its closing fence with the JSON block's opening one.
  assert.deepEqual(structuredFromReply('See:\n```javascript\nreturn value = 1;\n```\nWhy.\n\n```json\n{\n  "a": "x"\n}\n```', schema), { a: 'x' });
  assert.throws(() => structuredFromReply('```javascript\n{"a":1}\n```', schema), /no fenced JSON/);
  assert.throws(() => structuredFromReply('```json\n{"b":1}\n```', schema), /lacks a/);
  assert.throws(() => structuredFromReply('```json\n[1]\n```', schema), /not an object/);
});

test('changed files are those whose content hash differs', () => {
  const before = { head: 'h', hashes: { 'a.txt': '1', 'b.txt': '2' } };
  assert.deepEqual(changedFiles(before, { head: 'h', hashes: { 'a.txt': '1', 'b.txt': '3', 'c.txt': '4' } }), ['b.txt', 'c.txt']);
  assert.deepEqual(changedFiles(before, before), []);
});
