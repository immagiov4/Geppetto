import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { symlink } from 'node:fs/promises';
import { fixture, put, git } from './helpers.mjs';
import { appendRecord } from '../skills/geppetto-adopt/scripts/common.mjs';
import { localRecords, signalArchive } from '../skills/geppetto-adopt/scripts/signal.mjs';
import { learningState, projectDataPath } from '../skills/geppetto-adopt/scripts/project-records.mjs';
import { runLearning } from '../skills/geppetto-adopt/scripts/learn-runner.mjs';
import { learningAudit } from '../skills/geppetto-adopt/scripts/audit.mjs';
import { handleEvent, recordReview } from '../skills/geppetto-adopt/scripts/hook.mjs';

function repositories(t) {
  const parent = fixture(t), root = resolve(parent, 'main'), other = resolve(parent, 'other');
  const check = (cwd, args) => { const result = git(cwd, args); assert.equal(result.status, 0, result.stderr); return result; };
  check(parent, ['init', '-q', root]);
  check(root, ['config', 'user.name', 'Fixture']); check(root, ['config', 'user.email', 'fixture@example.invalid']);
  put(root, 'README.md', '# Project\n'); check(root, ['add', '.']); check(root, ['commit', '-qm', 'initial']);
  check(root, ['worktree', 'add', '-q', '-b', 'other', other]);
  return { root, other, check };
}

test('worktree evidence is shared and survives removal of its originating checkout', async t => {
  const { root, other, check } = repositories(t);
  await appendRecord(other, 'signals', { id: 'one', key: 'lost-work', session: 'delegated', status: 'open' });
  assert.equal((await signalArchive(root))[0]?.key, 'lost-work');
  check(root, ['worktree', 'remove', '--force', other]);
  const records = await localRecords(root, 'signals');
  assert.equal(records.length, 1); assert.equal(records[0].worktree, other);
  assert.equal(records[0].revision, check(root, ['rev-parse', 'HEAD']).stdout.trim());
  const unrelated = fixture(t); assert.deepEqual(await localRecords(unrelated, 'signals'), []);
});

test('legacy evidence from all live worktrees is recovered once, without losing later appends', async t => {
  const { root, other, check } = repositories(t);
  put(root, '.geppetto/signals.jsonl', '{"id":"old-main","ts":"2026-01-01","key":"old","status":"open"}\n');
  put(other, '.geppetto/signals.jsonl', '{"id":"old-other","ts":"2026-01-02","key":"other","status":"open"}\n');
  assert.equal((await localRecords(root, 'signals')).length, 2);
  await Promise.all([appendRecord(root, 'signals', { id: 'new-main' }), appendRecord(other, 'signals', { id: 'new-other' })]);
  assert.equal((await localRecords(other, 'signals')).length, 4);
  assert.equal((await localRecords(root, 'signals')).length, 4);
  check(root, ['worktree', 'remove', '--force', other]);
  assert.equal((await localRecords(root, 'signals')).length, 4);
});

test('all journals survive deletion while review eligibility remains checkout-specific', async t => {
  const { root, other, check } = repositories(t);
  for (const journal of ['turns', 'reviews', 'reads', 'hook-events', 'category-proposals']) {
    await appendRecord(other, journal, { ts: '2026-01-01T00:00:00Z', id: journal, path: resolve(other, 'README.md') });
    assert.equal((await localRecords(root, journal)).length, 1);
  }
  assert.deepEqual(await localRecords(root, 'reviews', { currentWorktree: true }), []);
  assert.equal((await localRecords(other, 'reviews', { currentWorktree: true })).length, 1);
  check(root, ['worktree', 'remove', '--force', other]);
  assert.equal((await learningAudit(root, { home: fixture(t) })).userFriction.turns, 1);
});

test('learning consumes shared evidence once and retains progress after the source worktree is removed', async t => {
  const { root, other, check } = repositories(t), home = fixture(t);
  put(other, '.geppetto/learning.json', { lastId: 'previous', status: 'unchanged' });
  assert.equal((await learningState(root)).state.lastId, 'previous');
  assert.equal((await learningState(root)).path, (await learningState(other)).path);
  put(other, 'chat.jsonl', JSON.stringify({ message: { role: 'user', content: 'Synthetic public correction' } }) + '\n');
  await appendRecord(other, 'signals', { id: 'pending', key: 'shared', session: 'delegated', source: 'user', status: 'open', category: 'workflow', text: 'Reusable correction', transcript_path: resolve(other, 'chat.jsonl') });
  check(root, ['worktree', 'remove', '--force', other]);
  const first = await runLearning(root, { home, execute: async () => ({ decision: 'no_change', reason: 'Already covered by the project instructions.', owner: 'README.md' }) });
  assert.equal(first.lastId, 'pending');
  assert.equal((await learningState(root)).state.lastId, 'pending');
  assert.equal((await signalArchive(root))[0].status, 'resolved');
  let executions = 0;
  const second = await runLearning(root, { home, execute: async () => { executions++; } });
  assert.equal(second.status, 'idle'); assert.equal(executions, 0);
});

test('reusing a removed checkout path cannot inherit its archived review approval', async t => {
  const { root, other, check } = repositories(t);
  const content = Array.from({ length: 40 }, (_, i) => `export const x${i} = ${i};\n`).join('');
  put(other, 'app.mjs', content); await recordReview(other, 'HEAD', 'passed');
  check(root, ['worktree', 'remove', '--force', other]); check(root, ['worktree', 'add', '-q', other, 'other']);
  put(other, '.geppetto/config.json', { hooks: { signalLearning: { enabled: false }, learnNudge: { enabled: false } } });
  await handleEvent({ cwd: other, hook_event_name: 'UserPromptSubmit', session_id: 'replacement', turn_id: 'one' });
  put(other, 'app.mjs', content);
  const result = await handleEvent({ cwd: other, hook_event_name: 'Stop', session_id: 'replacement', turn_id: 'one' });
  assert.equal(result.decision, 'block'); assert.match(result.reason, /independent review/);
});
