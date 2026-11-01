import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { repo } from './helpers.mjs';

test('review strategies preserve stage isolation, question accounting and failure evidence', () => {
  const result = spawnSync('python', ['-B', 'tests/review-runner-fixture.py'], { cwd: repo, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
