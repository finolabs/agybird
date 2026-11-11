import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { COMMANDS } from '../../scripts/companion.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const codex = JSON.parse(readFileSync(join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
const antigravity = JSON.parse(readFileSync(join(root, '.antigravity-plugin', 'plugin.json'), 'utf8'));
const EXPECTED = ['agybird', 'agybird-adversarial-review', 'agybird-cancel', 'agybird-image', 'agybird-rescue', 'agybird-result', 'agybird-review', 'agybird-setup', 'agybird-status', 'agybird-usage'];

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, 'frontmatter');
  return Object.fromEntries(match[1].split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]));
}

test('Codex loads its own skills folder, and Antigravity keeps the single skill', () => {
  assert.equal(codex.skills, './.codex-skills/');
  assert.equal(antigravity.skills, './.plugin-skills/');
  assert.deepEqual(readdirSync(join(root, '.plugin-skills')), ['agybird']);
  assert.deepEqual(readdirSync(join(root, '.codex-skills')).sort(), EXPECTED);
});

test('the Codex adapter is the same file Antigravity loads', () => {
  assert.equal(readFileSync(join(root, '.codex-skills', 'agybird', 'SKILL.md'), 'utf8'), readFileSync(join(root, '.plugin-skills', 'agybird', 'SKILL.md'), 'utf8'));
});

test('each command skill names its folder, runs only on request and calls a real companion command', () => {
  for (const name of EXPECTED.filter((entry) => entry !== 'agybird')) {
    // Windows checkouts may convert line endings; the frontmatter is the same either way.
    const text = readFileSync(join(root, '.codex-skills', name, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
    const meta = frontmatter(text);
    assert.equal(meta.name, name);
    assert.match(meta.description, /only when the user/i, `${name} must not trigger on its own`);
    const command = /scripts\/companion\.mjs" ([a-z-]+)/.exec(text)?.[1];
    assert.ok(command && COMMANDS[command], `${name} calls an unknown companion command ${command}`);
    assert.equal(name.replace(/^agybird-/, ''), command === 'task' ? 'rescue' : command);
    assert.doesNotMatch(text, /--grant(?![-\w])/, `${name} must not pass a raw rule`);
  }
});

test('Codex shares the Stop hook file, which resolves through CLAUDE_PLUGIN_ROOT on both hosts', () => {
  assert.equal('hooks' in codex, false, 'Codex reads hooks/hooks.json by default');
  assert.ok(existsSync(join(root, 'hooks', 'hooks.json')));
  assert.match(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8'), /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/companion\.mjs\\" hook stop/);
});

test('Antigravity loads no subagent: Claude Code agents live outside agents/', () => {
  const claude = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.deepEqual(claude.agents, ['./claude-agents/agybird-rescue.md']);
  assert.ok(existsSync(join(root, 'claude-agents', 'agybird-rescue.md')));
  assert.deepEqual(readdirSync(join(root, 'agents')).filter((name) => name.endsWith('.md')), []);
});

test('host instructions call node through `command`, so a shell function named node cannot break them', () => {
  const sources = [
    ...readdirSync(join(root, 'commands')).map((name) => join(root, 'commands', name)),
    join(root, 'claude-agents', 'agybird-rescue.md'),
    ...readdirSync(join(root, '.codex-skills')).map((name) => join(root, '.codex-skills', name, 'SKILL.md')),
    join(root, 'references', 'common.md'),
  ];
  for (const path of sources) {
    const text = readFileSync(path, 'utf8');
    assert.doesNotMatch(text, /(?<!command )\bnode "/, `${path} calls node without command`);
  }
});
