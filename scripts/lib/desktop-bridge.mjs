// Calls desktop-ax.js once per step and parses its one JSON line. Tests point
// AGYBIRD_DESKTOP_BRIDGE at a Node script that stands in for osascript.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AX_SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'desktop-ax.js');
const DEFAULT_TIMEOUT_MS = 15_000;
const ANSWERS = new Set(['1', 'Skip']);

function bridgeCommand(env) {
  return env.AGYBIRD_DESKTOP_BRIDGE
    ? [process.execPath, [env.AGYBIRD_DESKTOP_BRIDGE]]
    : ['/usr/bin/osascript', ['-l', 'JavaScript', AX_SCRIPT_PATH]];
}

export function callBridge(args, { env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, input } = {}) {
  const name = args[0];
  if (name === 'answer' && !ANSWERS.has(args[1])) return Promise.reject(new Error('Desktop bridge refused the answer: only 1 or Skip may be answered.'));
  const [command, prefix] = bridgeCommand(env);
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, ...args], { env, shell: false, windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (input !== undefined) child.stdin.end(input);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Desktop bridge ${name} could not start: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`Desktop bridge ${name} timed out after ${timeoutMs}ms.`));
      if (code !== 0) return reject(new Error(`Desktop bridge ${name} exited with ${code}: ${stderr.trim().slice(0, 300)}`));
      let value;
      try {
        value = JSON.parse(stdout.trim().split('\n').pop());
      } catch {
        return reject(new Error(`Desktop bridge ${name} printed output that is not JSON.`));
      }
      if (!value || typeof value !== 'object') return reject(new Error(`Desktop bridge ${name} printed output that is not JSON.`));
      if (value.error) return reject(new Error(`Desktop bridge ${name} failed: ${value.error}`));
      resolve(value);
    });
  });
}
