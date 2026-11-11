import { chmodSync, copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const companionPath = join(projectRoot, 'scripts', 'companion.mjs');
const fakeBin = mkdtempSync(join(tmpdir(), 'agybird-companion-bin-'));
const fakeCommandPath = join(fakeBin, 'agy');
copyFileSync(join(projectRoot, 'tests', 'fixtures', 'fake-agy.mjs'), fakeCommandPath);
chmodSync(fakeCommandPath, 0o755);

export function companionEnv(extra = {}) {
  return {
    ...process.env,
    PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
    AGYBIRD_PROJECTS_DIR: mkdtempSync(join(tmpdir(), 'agybird-c-projects-')),
    AGYBIRD_STATE_DIR: mkdtempSync(join(tmpdir(), 'agybird-c-state-')),
    AGYBIRD_JOBS_DIR: mkdtempSync(join(tmpdir(), 'agybird-c-jobs-')),
    ...extra,
  };
}

export function runCompanion(args, { env = companionEnv(), cwd = mkdtempSync(join(tmpdir(), 'agybird-c-ws-')), input = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [companionPath, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, cwd, env }));
    child.stdin.end(input);
  });
}
