import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseArgs, validateRequest } from '../../scripts/agybird.mjs';

test('parses the complete supported argument surface', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-args-'));
  const reference = join(cwd, 'source.png');
  writeFileSync(reference, 'png');

  const options = parseArgs([
    '--category', 'image',
    '--cwd', cwd,
    '--mode', 'write',
    '--reference', reference,
    '--reference', reference,
    '--json-schema', '{"type":"object"}',
    '--conversation', 'conversation-1',
    '--grant', 'command(git status)',
    '--grant-scope', 'remember',
    '--model', 'gemini-example',
    '--effort', 'high',
    '--agent', 'reviewer',
    '--sandbox',
    '--timeout', '45s',
  ]);

  assert.deepEqual(options, {
    category: 'image',
    cwd,
    mode: 'write',
    references: [reference, reference],
    jsonSchema: '{"type":"object"}',
    conversation: 'conversation-1',
    grants: ['command(git status)'],
    grantScope: 'remember',
    model: 'gemini-example',
    effort: 'high',
    agent: 'reviewer',
    sandbox: true,
    newSession: false,
    noRecord: false,
    timeout: '45s',
  });
  assert.doesNotThrow(() => validateRequest(options));
});

test('defaults mode and timeout without pinning provider choices', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-defaults-'));
  const options = parseArgs(['--category', 'general', '--cwd', cwd]);

  assert.equal(options.mode, 'read');
  assert.equal(options.timeout, '10m');
  assert.equal(options.model, undefined);
  assert.equal(options.effort, undefined);
  assert.equal(options.agent, undefined);
  assert.equal(options.sandbox, false);
});

test('accepts each category and effort value', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-enums-'));
  for (const category of ['code', 'image', 'general']) {
    assert.doesNotThrow(() => validateRequest(parseArgs(['--category', category, '--cwd', cwd])));
  }
  // agy 1.2.11 added xhigh and max for models that support them.
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.doesNotThrow(() => validateRequest(parseArgs([
      '--category', 'code', '--cwd', cwd, '--effort', effort,
    ])));
  }
});

test('rejects missing required arguments and missing flag values', () => {
  assert.throws(() => parseArgs([]), /--category is required/);
  assert.throws(() => parseArgs(['--category', 'code']), /--cwd is required/);
  assert.throws(() => parseArgs(['--category']), /requires a value/);
});

test('rejects unknown flags and invalid enum values', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-invalid-'));
  assert.throws(() => parseArgs(['--category', 'code', '--cwd', cwd, '--wat']), /Unknown option/);
  assert.throws(
    () => validateRequest(parseArgs(['--category', 'video', '--cwd', cwd])),
    /Invalid category/,
  );
  assert.throws(
    () => validateRequest(parseArgs(['--category', 'code', '--cwd', cwd, '--mode', 'unsafe'])),
    /Invalid mode/,
  );
  assert.throws(
    () => validateRequest(parseArgs(['--category', 'code', '--cwd', cwd, '--effort', 'extreme'])),
    /Invalid effort/,
  );
});

test('requires absolute existing directories and image reference files', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-paths-'));
  const directoryReference = join(cwd, 'directory.png');
  const missingReference = join(cwd, 'missing.png');
  mkdirSync(directoryReference);

  assert.throws(
    () => validateRequest(parseArgs(['--category', 'code', '--cwd', '.'])),
    /--cwd must be absolute/,
  );
  assert.throws(
    () => validateRequest(parseArgs(['--category', 'code', '--cwd', join(cwd, 'absent')])),
    /working directory does not exist/,
  );
  assert.throws(
    () => validateRequest(parseArgs([
      '--category', 'image', '--cwd', cwd, '--reference', 'relative.png',
    ])),
    /reference path must be absolute/,
  );
  assert.throws(
    () => validateRequest(parseArgs([
      '--category', 'image', '--cwd', cwd, '--reference', missingReference,
    ])),
    /reference image does not exist/,
  );
  assert.throws(
    () => validateRequest(parseArgs([
      '--category', 'image', '--cwd', cwd, '--reference', directoryReference,
    ])),
    /reference image is not a regular file/,
  );
});

test('rejects references outside image work and invalid timeouts', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agybird-reference-'));
  const reference = join(cwd, 'source.jpg');
  writeFileSync(reference, 'jpg');

  assert.throws(
    () => validateRequest(parseArgs([
      '--category', 'code', '--cwd', cwd, '--reference', reference,
    ])),
    /--reference is only valid with category image/,
  );
  for (const timeout of ['0', '-1s', 'forever', '1h']) {
    assert.throws(
      () => validateRequest(parseArgs([
        '--category', 'general', '--cwd', cwd, '--timeout', timeout,
      ])),
      /Invalid timeout/,
    );
  }
});
