import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

test('README documents installation and both target agents', () => {
  const readme = read('README.md');
  assert.match(readme, /npx skills add finolabs\/agybird/);
  assert.match(readme, /Claude Code/);
  assert.match(readme, /Codex/);
  assert.match(readme, /Node\.js 20/);
  assert.match(readme, /official.*`agy`|`agy`.*official/i);
});

test('README describes three categories and the provider boundary', () => {
  const readme = read('README.md');
  for (const category of ['Code', 'Image', 'General']) {
    assert.match(readme, new RegExp(category, 'i'));
  }
  assert.match(readme, /subscription eligibility/i);
  assert.match(readme, /quota/i);
  assert.match(readme, /permissions/i);
  assert.match(readme, /content policy/i);
});

test('security policy uses private GitHub advisories and has supported versions', () => {
  const security = read('SECURITY.md');
  assert.match(security, /private security advisory/i);
  // The supported line must follow the release, or the policy silently drops the current version.
  const [major, minor] = JSON.parse(read('package.json')).version.split('.');
  assert.match(security, new RegExp(`\\| ${major}\\.${minor}\\.x \\| Yes \\|`));
  assert.doesNotMatch(security, /security@example|YOUR_EMAIL/i);
});

test('threat model covers the required trust and abuse cases', () => {
  const threatModel = read('docs/threat-model.md');
  for (const topic of [
    'PATH',
    'malicious prompt',
    'malicious repository',
    'oversized output',
    'artifact path spoofing',
    'soft-denial',
    'supply-chain',
    'local data disclosure',
  ]) {
    assert.match(threatModel, new RegExp(topic, 'i'));
  }
});

test('community files contain concrete contribution and conduct policies', () => {
  assert.match(read('CONTRIBUTING.md'), /npm run check/);
  assert.match(read('CONTRIBUTING.md'), /zero runtime dependencies/i);
  assert.match(read('CODE_OF_CONDUCT.md'), /enforcement/i);
});

test('documentation links only to current official Antigravity pages', () => {
  const documentation = [
    read('README.md'),
    read('SECURITY.md'),
    read('docs/threat-model.md'),
  ].join('\n');
  assert.match(documentation, /https:\/\/antigravity\.google\/docs\/cli\/overview/);
  assert.match(documentation, /https:\/\/antigravity\.google\/docs\/cli\/install/);
  assert.match(documentation, /https:\/\/antigravity\.google\/terms/);
});
