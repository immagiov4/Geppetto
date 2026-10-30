import { projectDataPath } from '../skills/geppetto-adopt/scripts/project-records.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixture, put, get, git, invoke, config } from './helpers.mjs';
import { handleEvent } from '../skills/geppetto-adopt/scripts/hook.mjs';

const lines = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i}\n`).join('');
function project(t) {
  const cwd = fixture(t);
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) assert.equal(git(cwd, args).status, 0);
  put(cwd, 'app.mjs', lines(40)); put(cwd, '.geppetto/config.json', config());
  git(cwd, ['add', '.']); git(cwd, ['commit', '-qm', 'baseline']);
  const send = async (hook_event_name, extra = {}) => {
    const result = await handleEvent({ cwd, session_id: 'gate', turn_id: 'one', hook_event_name, ...extra });
    if (hook_event_name === 'UserPromptSubmit') {
      const recorded = invoke('hook.mjs', ['--record-turn', JSON.stringify({ continuation: true }), '--session', 'gate', '--turn', extra.turn_id ?? 'one'], { cwd });
      assert.equal(recorded.status, 0, recorded.stderr);
    }
    return result;
  };
  return { cwd, send };
}
test('40 new source lines block once, including untracked source, and the next turn can block again', async t => {
  const { cwd, send } = project(t); await send('UserPromptSubmit');
  put(cwd, 'new.mjs', lines(40, 'new'));
  const blocked = await send('Stop'); assert.equal(blocked.decision, 'block'); assert.match(blocked.reason, /Code changed without an independent review/);
  assert.equal(get(cwd, projectDataPath(cwd, 'hook-events.jsonl')).trim().split('\n').map(JSON.parse).find(row => row.hook === 'reviewGate').lines, 40, 'runtime dotfiles must not inflate the source count');
  assert.deepEqual(await send('Stop'), {});
  await send('UserPromptSubmit', { turn_id: 'two' }); put(cwd, 'new.mjs', lines(80, 'new'));
  assert.equal((await send('Stop', { turn_id: 'two' })).decision, 'block');
  assert.equal(git(cwd, ['check-ignore', '.geppetto/reviews.jsonl']).status, 0);
  assert.match(get(cwd, projectDataPath(cwd, 'hook-events.jsonl')), /reviewGate/);
});
test('matching review passes, small post-review edits pass, substantial post-review edits block', async t => {
  const { cwd, send } = project(t); await send('UserPromptSubmit'); put(cwd, 'app.mjs', lines(80));
  const recorded = invoke('hook.mjs', ['--record-review', '--base', 'HEAD', '--outcome', 'passed'], { cwd });
  assert.equal(recorded.status, 0, recorded.stderr); const record = JSON.parse(get(cwd, projectDataPath(cwd, 'reviews.jsonl')));
  assert.match(record.hash, /^[a-f\d]{64}$/); assert.match(record.base, /^[a-f\d]{40}$/); assert.equal(record.outcome, 'passed'); assert.ok(record.ts);
  assert.doesNotMatch(get(cwd, projectDataPath(cwd, 'reviews.jsonl')), /line 40/);
  assert.deepEqual(await send('Stop'), {});
  put(cwd, 'app.mjs', lines(90)); assert.deepEqual(await send('Stop'), {});
  put(cwd, 'app.mjs', lines(120)); assert.equal((await send('Stop')).decision, 'block');
});
test('docs/tests-only changes pass, configurable exclusions and threshold apply', async t => {
  const { cwd, send } = project(t); await send('UserPromptSubmit');
  for (const file of ['docs/manual.txt', 'tests/app.mjs', 'app.test.mjs', 'README.md']) put(cwd, file, lines(40));
  assert.deepEqual(await send('Stop'), {});
  assert.equal(get(cwd, projectDataPath(cwd, 'hook-events.jsonl')).trim().split('\n').map(JSON.parse).find(row => row.hook === 'reviewGate').lines, 0);
  put(cwd, '.geppetto/config.json', { ...config(), hooks: { reviewGate: { enabled: true, threshold: 50, docGlobs: ['generated/**'], testGlobs: ['checks/**'] } } });
  await send('UserPromptSubmit', { turn_id: 'two' }); put(cwd, 'generated/app.mjs', lines(80)); put(cwd, 'checks/app.mjs', lines(80)); put(cwd, 'extra.mjs', lines(40));
  assert.deepEqual(await send('Stop', { turn_id: 'two' }), {});
});
test('old dirty source is not a change this turn; active stop and explicit blocker close safely', async t => {
  const { cwd, send } = project(t); put(cwd, 'app.mjs', lines(100)); await send('UserPromptSubmit');
  assert.deepEqual(await send('Stop'), {});
  put(cwd, 'app.mjs', lines(140)); assert.deepEqual(await send('Stop', { stop_hook_active: true }), {});
  await send('UserPromptSubmit', { turn_id: 'two' }); put(cwd, 'app.mjs', lines(180));
  assert.deepEqual(await send('Stop', { turn_id: 'two', last_assistant_message: 'Independent review blocked: the requested CLI is unavailable.' }), {});
  assert.match(get(cwd, projectDataPath(cwd, 'hook-events.jsonl')), /blocker/);
});
test('deletions and staged edits count, and an earlier matching review remains valid', async t => {
  const { cwd, send } = project(t); await send('UserPromptSubmit');
  put(cwd, 'app.mjs', lines(80)); git(cwd, ['add', 'app.mjs']);
  assert.equal(invoke('hook.mjs', ['--record-review', '--base', 'HEAD', '--outcome', 'findings'], { cwd }).status, 0);
  put(cwd, 'app.mjs', lines(120));
  assert.equal(invoke('hook.mjs', ['--record-review', '--base', 'HEAD', '--outcome', 'passed'], { cwd }).status, 0);
  put(cwd, 'app.mjs', lines(80)); assert.deepEqual(await send('Stop'), {}, 'the first review matches again');
  await send('UserPromptSubmit', { turn_id: 'two' }); put(cwd, 'app.mjs', '');
  assert.equal((await send('Stop', { turn_id: 'two' })).decision, 'block');
});
test('disabled review gate stays quiet and malformed threshold fails explicitly', async t => {
  const { cwd, send } = project(t);
  put(cwd, '.geppetto/config.json', { ...config(), hooks: { reviewGate: { enabled: false } } });
  await send('UserPromptSubmit'); put(cwd, 'new.mjs', lines(40)); assert.deepEqual(await send('Stop'), {});
  put(cwd, '.geppetto/config.json', { ...config(), hooks: { reviewGate: { threshold: 0 } } });
  await assert.rejects(send('UserPromptSubmit'), /Invalid hooks.reviewGate/);
});
test('concurrent Stop deliveries claim only one block', async t => {
  const { cwd, send } = project(t); await send('UserPromptSubmit'); put(cwd, 'extra.mjs', lines(40));
  const results = await Promise.all([send('Stop'), send('Stop')]); assert.equal(results.filter(result => result.decision === 'block').length, 1);
});
test('a reviewed clean diff cannot hide a source file replaced by a directory or binary', async t => {
  for (const replacement of ['directory', 'binary']) {
    const { cwd, send } = project(t); await send('UserPromptSubmit');
    assert.equal(invoke('hook.mjs', ['--record-review', '--base', 'HEAD', '--outcome', 'passed'], { cwd }).status, 0);
    rmSync(resolve(cwd, 'app.mjs'));
    if (replacement === 'directory') mkdirSync(resolve(cwd, 'app.mjs')); else put(cwd, 'app.mjs', '\0binary');
    assert.equal((await send('Stop')).decision, 'block');
  }
});

test('delegate findings recorded by CLI satisfy the gate through small fixes and clear a prior block', async t => {
  const { cwd, send } = project(t); await send('UserPromptSubmit'); put(cwd, 'app.mjs', lines(80));
  const blocked = await send('Stop'); assert.match(blocked.reason, /--record-review.*--outcome/);
  assert.equal(invoke('hook.mjs', ['--record-review', '--base', 'HEAD', '--outcome', 'findings'], { cwd }).status, 0);
  put(cwd, 'app.mjs', lines(85)); assert.deepEqual(await send('Stop'), {});
  assert.equal(get(cwd, projectDataPath(cwd, 'hook-events.jsonl')).trim().split('\n').map(JSON.parse).filter(row => row.hook === 'reviewGate').at(-1).status, 'below-threshold');
  put(cwd, 'app.mjs', lines(120));
  await send('UserPromptSubmit', { turn_id: 'next' }); put(cwd, 'app.mjs', lines(160));
  assert.equal((await send('Stop', { turn_id: 'next' })).decision, 'block');
});
