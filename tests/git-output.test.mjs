import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, git } from './helpers.mjs';
import { gitOutput } from '../skills/geppetto-adopt/scripts/common.mjs';

test('Git text reads preserve output larger than the child-process default buffer', t => {
  const cwd = fixture(t);
  assert.equal(git(cwd, ['init', '-q']).status, 0);
  const contents = 'large repository inventory à\0'.repeat(80000);
  const stored = git(cwd, ['hash-object', '-w', '--stdin'], { input: contents });
  assert.equal(stored.status, 0, stored.stderr);
  assert.equal(gitOutput(cwd, ['cat-file', 'blob', stored.stdout.trim()], { trim: false }), contents);
  assert.throws(() => gitOutput(cwd, ['cat-file', 'blob', stored.stdout.trim()], { maxBuffer: 1024 }), /ENOBUFS/);
  assert.throws(() => gitOutput(cwd, ['cat-file', 'blob', 'missing-object']), /Git operation failed/);
});
