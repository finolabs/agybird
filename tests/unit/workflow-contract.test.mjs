import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

function assertPinnedActions(workflow) {
  const uses = [...workflow.matchAll(/^\s*- uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  assert.ok(uses.length > 0, 'workflow has no actions');
  for (const action of uses) {
    assert.match(action, /^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/, `${action} is not pinned by full SHA`);
  }
}

test('CI uses immutable actions and least-privilege permissions', () => {
  const workflow = read('.github/workflows/ci.yml');
  assertPinnedActions(workflow);
  assert.match(workflow, /^permissions:\r?\n  contents: read\r?$/m);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.doesNotMatch(workflow, /secrets\.|GOOGLE_|GEMINI_|ANTIGRAVITY_/);
});

test('CI covers supported systems and Node versions on main, one job on a pull request', () => {
  const workflow = read('.github/workflows/ci.yml');
  assert.match(workflow, /fromJSON\('\["ubuntu-latest", "macos-latest", "windows-latest"\]'\)/);
  assert.match(workflow, /fromJSON\('\[20, 22\]'\)/);
  assert.match(workflow, /pull_request' && fromJSON\('\["ubuntu-latest"\]'\)/);
  assert.match(workflow, /pull_request' && fromJSON\('\[22\]'\)/);
  // A newer push cancels a pull request's run, never main's.
  assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  // Every pull request runs, so the required check always reports.
  assert.doesNotMatch(workflow, /paths-ignore|paths:/);
  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm run check/);
});

test('one gate check reports the whole matrix, so the branch rules require only it', () => {
  const workflow = read('.github/workflows/ci.yml');
  assert.match(workflow, /^  gate:\r?\n    name: CI gate\r?\n    needs: test\r?\n    if: always\(\)\r?$/m);
  assert.match(workflow, /RESULT: \$\{\{ needs\.test\.result \}\}/);
  assert.match(workflow, /run: test "\$RESULT" = success/);
});

test('release workflow validates tags before a least-privilege release', () => {
  const workflow = read('.github/workflows/release.yml');
  assertPinnedActions(workflow);
  assert.match(workflow, /tags:\r?\n\s+- ['"]v\*['"]/);
  assert.match(workflow, /^permissions:\r?\n  contents: read\r?$/m);
  assert.match(workflow, /^\s+permissions:\r?\n\s+contents: write\r?$/m);
  assert.match(workflow, /npm run check/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /\.claude-plugin\/plugin\.json/);
  assert.match(workflow, /\.codex-plugin\/plugin\.json/);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.doesNotMatch(workflow, /secrets\.(?!GITHUB_TOKEN)/);
});
