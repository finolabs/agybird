import assert from 'node:assert/strict';
import test from 'node:test';

import { assertTransportSupported, resolveTransport } from '../../scripts/lib/transport.mjs';

test('no choice anywhere resolves the CLI by default', () => {
  assert.deepEqual(resolveTransport({}), { transport: 'cli', source: 'default' });
  assert.deepEqual(resolveTransport({ workspace: {}, global: {} }), { transport: 'cli', source: 'default' });
});

test('a flag beats the workspace, which beats the global choice', () => {
  assert.deepEqual(resolveTransport({ global: { transport: 'desktop' } }), { transport: 'desktop', source: 'global' });
  assert.deepEqual(resolveTransport({ workspace: { transport: 'cli' }, global: { transport: 'desktop' } }), { transport: 'cli', source: 'workspace' });
  assert.deepEqual(resolveTransport({ flag: 'desktop', workspace: { transport: 'cli' }, global: { transport: 'cli' } }), { transport: 'desktop', source: 'flag' });
});

test('an unknown transport is refused with the accepted values', () => {
  assert.throws(() => resolveTransport({ flag: 'browser' }), /cli, desktop/);
  assert.throws(() => resolveTransport({ workspace: { transport: 'gui' } }), /cli, desktop/);
  assert.throws(() => resolveTransport({ global: { transport: 1 } }), /cli, desktop/);
});

test('the desktop transport is refused outside macOS', () => {
  assert.doesNotThrow(() => assertTransportSupported('desktop', 'darwin'));
  assert.doesNotThrow(() => assertTransportSupported('cli', 'linux'));
  assert.throws(() => assertTransportSupported('desktop', 'linux'), /macOS/);
  assert.throws(() => assertTransportSupported('desktop', 'win32'), /macOS/);
});
