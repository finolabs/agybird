import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAgyArgs, killDeadline, killGrace } from '../../scripts/agybird.mjs';

test('builds the minimal official headless invocation', () => {
  assert.deepEqual(
    buildAgyArgs({ mode: 'read', timeout: '90s' }, 'delegated prompt'),
    [
      '-p', 'delegated prompt',
      '--mode', 'plan',
      '--output-format', 'stream-json',
      '--print-timeout', '90s',
    ],
  );
});

test('maps explicitly supplied provider options without changing them', () => {
  const options = {
    mode: 'write',
    timeout: '10m',
    jsonSchema: '{"type":"object"}',
    conversation: 'conversation-42',
    model: 'gemini-example',
    effort: 'medium',
    agent: 'coder',
    sandbox: true,
  };

  assert.deepEqual(buildAgyArgs(options, 'task'), [
    '-p', 'task',
    '--mode', 'accept-edits',
    '--output-format', 'stream-json',
    '--print-timeout', '10m',
    '--json-schema', '{"type":"object"}',
    '--conversation', 'conversation-42',
    '--model', 'gemini-example',
    '--effort', 'medium',
    '--agent', 'coder',
    '--sandbox',
  ]);
});

test('does not emit implicit provider, sandbox, credit, or permission choices', () => {
  const args = buildAgyArgs({ mode: 'read', timeout: '10m', sandbox: false }, 'task');
  const serialized = args.join(' ');

  assert.doesNotMatch(serialized, /--model/);
  assert.doesNotMatch(serialized, /--effort/);
  assert.doesNotMatch(serialized, /--agent/);
  assert.doesNotMatch(serialized, /--sandbox/);
  assert.doesNotMatch(serialized, /useG1Credits/);
  assert.doesNotMatch(serialized, /dangerously-skip-permissions/);
});

// The kill timer starts at spawn, before agy's own print-timeout timer, so a short
// timeout still needs a fixed minimum grace for agy to start and answer.
test('keeps a minimum kill grace and caps it for long timeouts', () => {
  assert.equal(killGrace('50ms'), 5_000);
  assert.equal(killGrace('8s'), 8_000);
  assert.equal(killGrace('10m'), 10_000);
  assert.equal(killDeadline('50ms'), 5_050);
});

test('--swarm puts the /swarm command in front of the delegated prompt', () => {
  const args = buildAgyArgs({ mode: 'read', timeout: '10m', swarm: true }, 'task');
  assert.equal(args[0], '-p');
  assert.equal(args[1], '/swarm task');
  assert.equal(buildAgyArgs({ mode: 'read', timeout: '10m', swarm: false }, 'task')[1], 'task');
});
