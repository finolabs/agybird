// Which way a run reaches Antigravity: the agy CLI (the default) or the
// desktop app driven through macOS Accessibility. A choice on the command line
// beats the workspace's, which beats the global one.

export const TRANSPORTS = ['cli', 'desktop'];

export function checkTransport(value, where) {
  if (!TRANSPORTS.includes(value)) throw new Error(`Unknown transport ${JSON.stringify(value)} in ${where}; use one of: ${TRANSPORTS.join(', ')}.`);
  return value;
}

export function resolveTransport({ flag, workspace = {}, global = {} } = {}) {
  if (flag !== undefined) return { transport: checkTransport(flag, 'the command line'), source: 'flag' };
  if (workspace.transport !== undefined) return { transport: checkTransport(workspace.transport, 'the workspace config'), source: 'workspace' };
  if (global.transport !== undefined) return { transport: checkTransport(global.transport, 'the global config'), source: 'global' };
  return { transport: 'cli', source: 'default' };
}

export function assertTransportSupported(transport, platform = process.platform) {
  if (transport === 'desktop' && platform !== 'darwin') throw new Error('The desktop transport drives the Antigravity app through macOS Accessibility and runs only on macOS.');
}
