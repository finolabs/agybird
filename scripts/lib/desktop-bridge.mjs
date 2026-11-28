// Calls desktop-ax.js once per step and parses its one JSON line. Tests point
// AGYBIRD_DESKTOP_BRIDGE at a Node script that stands in for osascript.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

export const AX_SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'desktop-ax.js');

// The pure decisions of desktop-ax.js (its `desktop-decisions` region), the
// same source osascript runs, evaluated alone in an empty context: no
// accessibility object exists there, so the region cannot depend on one.
export function loadAxDecisions(source = readFileSync(AX_SCRIPT_PATH, 'utf8')) {
  const start = source.indexOf('// desktop-decisions:start');
  const end = source.indexOf('// desktop-decisions:end');
  if (start < 0 || end < start) throw new Error('desktop-ax.js has no desktop-decisions region');
  return runInNewContext(`${source.slice(start, end)}\n;({ UNTITLED, OPTION_1, flatten, title, marker, ownConversation, requireOwn, namedConversation, dialogs, chooseAnswer, running, chooseStop, chooseCopy, chooseComposer, reply })`, {}, { filename: AX_SCRIPT_PATH });
}
const DEFAULT_TIMEOUT_MS = 15_000;
const ANSWERS = new Set(['1', 'Skip']);

function bridgeCommand(env) {
  return env.AGYBIRD_DESKTOP_BRIDGE
    ? [process.execPath, [env.AGYBIRD_DESKTOP_BRIDGE]]
    : ['/usr/bin/osascript', ['-l', 'JavaScript', AX_SCRIPT_PATH]];
}

// `signal` interrupts the step: its process is killed and the call rejects, so a
// cancelled run never waits out a long step (a paste) before it cleans up.
export function callBridge(args, { env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, input, signal } = {}) {
  const name = args[0];
  if (name === 'answer' && !ANSWERS.has(args[1])) return Promise.reject(new Error('Desktop bridge refused the answer: only 1 or Skip may be answered.'));
  if (name === 'answer' && (!args[2] || !args[3] || !args[4])) return Promise.reject(new Error('Desktop bridge refused the answer: an answer needs the approved question, the conversation title and the run marker.'));
  if (signal?.aborted) return Promise.reject(new Error(`Desktop bridge ${name} was interrupted.`));
  const [command, prefix] = bridgeCommand(env);
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, ...args], { env, shell: false, windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (input !== undefined) child.stdin.on('error', () => {}).end(input);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let interrupted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const interrupt = () => {
      interrupted = true;
      child.kill('SIGKILL');
    };
    signal?.addEventListener('abort', interrupt, { once: true });
    const settle = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', interrupt);
    };
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      settle();
      reject(new Error(`Desktop bridge ${name} could not start: ${error.message}`));
    });
    child.on('close', (code) => {
      settle();
      if (interrupted) return reject(new Error(`Desktop bridge ${name} was interrupted.`));
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
