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
  assert.equal(reason({ ...probe, version: '2.36.0' }), 'unsupported_version');
  assert.equal(reason({ ...probe, version: '2.36.0' }, { allowVersion: true }), null);
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
  assert.ok(request.question.length <= 301);
});

test('the structured output is the last fenced JSON block and must hold the required keys', () => {
  const schema = { type: 'object', required: ['a'] };
  assert.deepEqual(structuredFromReply('```json\n{"a":0}\n```\ntext\n```json\n{"a":1}\n```', schema), { a: 1 });
  assert.throws(() => structuredFromReply('none', schema), /no fenced JSON/);
  assert.throws(() => structuredFromReply('```json\n{"b":1}\n```', schema), /lacks a/);
  assert.throws(() => structuredFromReply('```json\n[1]\n```', schema), /not an object/);
});

test('changed files are those whose content hash differs', () => {
  const before = { head: 'h', hashes: { 'a.txt': '1', 'b.txt': '2' } };
  assert.deepEqual(changedFiles(before, { head: 'h', hashes: { 'a.txt': '1', 'b.txt': '3', 'c.txt': '4' } }), ['b.txt', 'c.txt']);
  assert.deepEqual(changedFiles(before, before), []);
});
