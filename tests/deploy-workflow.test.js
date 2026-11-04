import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const sourceSha = '1111111111111111111111111111111111111111';
const otherSha = '2222222222222222222222222222222222222222';

function verificationScript() {
  const lines = workflow.split('\n');
  const heading = lines.indexOf('      - name: Verify production deployment source');
  assert.ok(heading >= 0, 'production verification step exists');
  const start = lines.indexOf('        run: |', heading);
  assert.ok(start > heading, 'verification step has a shell script');
  const end = lines.findIndex((line, index) => index > start && line.startsWith('      - '));
  assert.ok(end > start, 'verification script is followed by another step');
  return lines.slice(start + 1, end).map(line => line.startsWith('          ')
    ? line.slice(10) : line).join('\n');
}

test('production deploy exposes explicit manual dispatch while retaining tag and deployment safeguards', () => {
  assert.match(workflow, /^  workflow_dispatch:\s*$/m);
  assert.match(workflow, /^    tags:\s*$/m);
  assert.match(workflow, /^    branches:\s*$/m);
  assert.match(workflow, /^      - '\.github\/deploy-requests\/production\.txt'$/m);
  assert.match(workflow, /group: cws-analytics-mcp-production/);
  assert.match(workflow, /environment: production/);
  for (const step of ['npm ci', 'npm test', 'npm run check', 'scripts/validate-deploy.mjs',
    'scripts/ensure-collector-triggers.mjs', 'npm run deploy', 'scripts/smoke.mjs']) {
    assert.ok(workflow.includes(step), 'deploy retains ' + step);
  }
});

test('production source validation accepts only current main for manual deploys and preserves tag rules', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cws-mcp-deploy-'));
  try {
    const mockGit = join(cwd, 'git');
    writeFileSync(mockGit, String.raw`#!/bin/sh
if [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ]; then
  echo "$CHECKOUT_SHA"
elif [ "$1" = "rev-parse" ] && [ "$2" = "origin/main" ]; then
  echo "$MAIN_SHA"
elif [ "$1" = "fetch" ]; then
  exit 0
elif [ "$1" = "diff-tree" ]; then
  printf '%s\n' "$CHANGED_PATHS"
elif [ "$1" = "merge-base" ] && [ "$2" = "--is-ancestor" ]; then
  [ "$3" = "$ANCESTOR_SHA" ] && [ "$4" = "origin/main" ]
else
  exit 1
fi
`);
    chmodSync(mockGit, 0o755);
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ version: packageVersion }));
    const script = verificationScript();
    const run = ({ event = 'workflow_dispatch', ref = 'refs/heads/main',
      sha = sourceSha, checkedOut = sourceSha, main = sourceSha,
      tag = 'main', ancestor = sourceSha,
      changedPaths = '.github/deploy-requests/production.txt' } = {}) => {
      const { status, stderr, stdout } = spawnSync('bash', ['-c', script], {
        cwd, encoding: 'utf8',
        env: { ...process.env, PATH: cwd + ':' + process.env.PATH,
          GITHUB_EVENT_NAME: event, GITHUB_REF: ref, TAG: tag, SOURCE_SHA: sha,
          CHECKOUT_SHA: checkedOut, MAIN_SHA: main, ANCESTOR_SHA: ancestor,
          CHANGED_PATHS: changedPaths },
      });
      return { status, output: stdout + stderr };
    };
    assert.equal(run().status, 0, 'current main can deploy manually');
    assert.notEqual(run({ ref: 'refs/heads/feature' }).status, 0, 'manual deploy cannot use feature');
    assert.notEqual(run({ main: otherSha }).status, 0, 'manual deploy cannot use stale main');
    assert.notEqual(run({ checkedOut: otherSha }).status, 0, 'checkout must match requested SHA');
    assert.equal(run({ event: 'push', ref: 'refs/heads/main' }).status, 0,
      'explicit marker-only main push can deploy');
    assert.notEqual(run({ event: 'push', main: otherSha }).status, 0,
      'explicit marker push must target current main');
    assert.notEqual(run({ event: 'push', changedPaths: '.github/deploy-requests/production.txt\nsrc/index.js' }).status, 0,
      'explicit marker push must not include unrelated changes');
    assert.notEqual(run({ event: 'push', changedPaths: 'src/index.js' }).status, 0,
      'ordinary source pushes do not deploy');
    assert.equal(run({ event: 'push', ref: 'refs/tags/v' + packageVersion,
      tag: 'v' + packageVersion }).status, 0, 'matching release tag can deploy');
    assert.notEqual(run({ event: 'push', ref: 'refs/tags/v0.0.0', tag: 'v0.0.0' }).status, 0,
      'version mismatch is rejected');
    assert.notEqual(run({ event: 'push', ref: 'refs/tags/v' + packageVersion,
      tag: 'v' + packageVersion, ancestor: otherSha }).status, 0,
      'tag outside main ancestry is rejected');
    assert.notEqual(run({ event: 'schedule' }).status, 0, 'unsupported event is rejected');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
