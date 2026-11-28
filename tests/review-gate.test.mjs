import { turnStatePath } from '../skills/geppetto-adopt/scripts/turn-messages.mjs';
import { projectDataPath } from '../skills/geppetto-adopt/scripts/project-records.mjs';
import { test } from 'node:test';
import { metricsAudit } from '../skills/geppetto-adopt/scripts/metrics-audit.mjs';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixture, put, get, git, invoke, config, reviewFixture, invokeReview } from './helpers.mjs';
import { handleEvent } from '../skills/geppetto-adopt/scripts/hook.mjs';

const lines = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i}\n`).join('');
test('global review hook leaves an unadopted repository alone', async t => {
  const cwd = fixture(t);
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) assert.equal(git(cwd, args).status, 0);
  put(cwd, 'app.mjs', lines(40)); git(cwd, ['add', '.']); git(cwd, ['commit', '-qm', 'baseline']);
  const event = { cwd, session_id: 'unadopted', turn_id: 'one' };
  await handleEvent({ ...event, hook_event_name: 'UserPromptSubmit' });
  put(cwd, 'app.mjs', lines(100));
  assert.deepEqual(await handleEvent({ ...event, hook_event_name: 'Stop' }), {});
});
function project(t) {
  const cwd = fixture(t), nativeHome = fixture(t);
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) assert.equal(git(cwd, args).status, 0);
  put(cwd, 'app.mjs', lines(40)); put(cwd, '.geppetto/config.json', config());
  git(cwd, ['add', '.']); git(cwd, ['commit', '-qm', 'baseline']);
  const send = async (hook_event_name, extra = {}) => {
    const result = await handleEvent({ cwd, session_id: 'gate', turn_id: 'one', hook_event_name, ...extra }, { codexHome: nativeHome });
    if (hook_event_name === 'UserPromptSubmit') {
      const recorded = invoke('hook.mjs', ['--record-turn', JSON.stringify({ continuation: true }), '--session', 'gate', '--turn', extra.turn_id ?? 'one'], { cwd });
      assert.equal(recorded.status, 0, recorded.stderr);
    }
    return result;
  };
  return { cwd, send, nativeHome };
}
test('untracked source blocks Codex Stop retries until an override, with a fresh check next turn', async t => {
  const { cwd, send } = project(t); await send('UserPromptSubmit');
  put(cwd, 'new.mjs', lines(40, 'new'));
  const blocked = await send('Stop'); assert.equal(blocked.decision, 'block'); assert.match(blocked.reason, /Code changed without an independent review/);
  assert.equal(get(cwd, projectDataPath(cwd, 'hook-events.jsonl')).trim().split('\n').map(JSON.parse).find(row => row.hook === 'reviewGate').lines, 40, 'runtime dotfiles must not inflate the source count');
  assert.equal((await send('Stop', { stop_hook_active: true })).decision, 'block');
  const override = { override: { gate: 'stop', reason: 'The reviewer cannot reach this fixture.' } };
  assert.equal(invoke('hook.mjs', ['--record-turn', JSON.stringify(override), '--session', 'gate', '--turn', 'one'], { cwd }).status, 0);
  assert.deepEqual(await send('Stop'), {});
  await send('UserPromptSubmit', { turn_id: 'two' }); put(cwd, 'new.mjs', lines(80, 'new'));
  assert.equal((await send('Stop', { turn_id: 'two' })).decision, 'block');
  assert.equal(git(cwd, ['check-ignore', '.geppetto/reviews.jsonl']).status, 0);
  assert.match(get(cwd, projectDataPath(cwd, 'hook-events.jsonl')), /reviewGate/);
});
test('matching review passes, small post-review edits pass, substantial post-review edits block', async t => {
  const { cwd, send, nativeHome } = project(t); await send('UserPromptSubmit'); put(cwd, 'app.mjs', lines(80));
  const recorded = invokeReview(t, cwd, 'passed', 'gate', 'one', nativeHome);
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
test('old dirty source passes; Codex requires a recorded override for active Stop or a stated blocker', async t => {
  const { cwd, send } = project(t); put(cwd, 'app.mjs', lines(100)); await send('UserPromptSubmit');
  assert.deepEqual(await send('Stop'), {});
  put(cwd, 'app.mjs', lines(140)); assert.equal((await send('Stop', { stop_hook_active: true })).decision, 'block');
  await send('UserPromptSubmit', { turn_id: 'two' }); put(cwd, 'app.mjs', lines(180));
  assert.equal((await send('Stop', { turn_id: 'two', last_assistant_message: 'Independent review blocked: the requested CLI is unavailable.' })).decision, 'block');
});
test('deletions and staged edits count, and an earlier matching review remains valid', async t => {
  const { cwd, send, nativeHome } = project(t); await send('UserPromptSubmit');
  put(cwd, 'app.mjs', lines(80)); git(cwd, ['add', 'app.mjs']);
  assert.equal(invokeReview(t, cwd, 'findings', 'gate', 'one', nativeHome).status, 0);
  put(cwd, 'app.mjs', lines(120));
  assert.equal(invokeReview(t, cwd, 'passed', 'gate', 'one', nativeHome).status, 0);
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
test('concurrent Codex Stops both require completion and record one first denial', async t => {
  const { cwd, send } = project(t); await send('UserPromptSubmit'); put(cwd, 'extra.mjs', lines(40));
  const results = await Promise.all([send('Stop'), send('Stop')]); assert.equal(results.filter(result => result.decision === 'block').length, 2);
  const events = get(cwd, projectDataPath(cwd, 'hook-events.jsonl')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.filter(row => row.hook === 'reviewGate').map(row => row.disposition), ['denied', 'retry-denied']);
});
test('a reviewed clean diff cannot hide a source file replaced by a directory or binary', async t => {
  for (const replacement of ['directory', 'binary']) {
    const { cwd, send, nativeHome } = project(t); await send('UserPromptSubmit');
    assert.equal(invokeReview(t, cwd, 'passed', 'gate', 'one', nativeHome).status, 0);
    rmSync(resolve(cwd, 'app.mjs'));
    if (replacement === 'directory') mkdirSync(resolve(cwd, 'app.mjs')); else put(cwd, 'app.mjs', '\0binary');
    assert.equal((await send('Stop')).decision, 'block');
  }
});

test('delegate findings recorded by CLI satisfy the gate through small fixes and clear a prior block', async t => {
  const { cwd, send, nativeHome } = project(t); await send('UserPromptSubmit'); put(cwd, 'app.mjs', lines(80));
  const blocked = await send('Stop'); assert.match(blocked.reason, /--record-review.*--outcome/);
  assert.equal(invokeReview(t, cwd, 'findings', 'gate', 'one', nativeHome).status, 0);
  put(cwd, 'app.mjs', lines(85)); assert.deepEqual(await send('Stop'), {});
  assert.equal(get(cwd, projectDataPath(cwd, 'hook-events.jsonl')).trim().split('\n').map(JSON.parse).filter(row => row.hook === 'reviewGate').at(-1).status, 'below-threshold');
  put(cwd, 'app.mjs', lines(120));
  await send('UserPromptSubmit', { turn_id: 'next' }); put(cwd, 'app.mjs', lines(160));
  assert.equal((await send('Stop', { turn_id: 'next' })).decision, 'block');
});

test('a review assertion with no review evidence cannot clear a blocked Stop', async t => {
  const { cwd, send, nativeHome } = project(t); await send('UserPromptSubmit');
  put(cwd, 'new.mjs', lines(40, 'new'));
  assert.equal((await send('Stop')).decision, 'block');
  const claimed = invoke('hook.mjs', ['--record-review', '--base', 'HEAD', '--outcome', 'passed',
    '--session', 'gate', '--turn', 'one'], { cwd });
  assert.equal(claimed.status, 2, claimed.stdout);
  const foreign = reviewFixture(t, cwd);
  const unsigned = invoke('hook.mjs', ['--record-review', '--base', 'HEAD', '--outcome', 'passed',
    '--session', 'gate', '--turn', 'one', '--evidence', foreign], { cwd, env: { CODEX_HOME: resolve(foreign, '.codex') } });
  assert.equal(unsigned.status, 2, unsigned.stdout);
  const stale = reviewFixture(t, cwd, 'passed', 'HEAD', nativeHome);
  put(cwd, 'new.mjs', lines(41, 'new'));
  const outdated = invoke('hook.mjs', ['--record-review', '--base', 'HEAD', '--outcome', 'passed',
    '--session', 'gate', '--turn', 'one', '--evidence', stale], { cwd, env: { CODEX_HOME: resolve(stale, '.codex') } });
  assert.equal(outdated.status, 2, outdated.stdout);
  assert.equal((await send('Stop', { stop_hook_active: true })).decision, 'block');
});

test('valid standard and ultra lens evidence clears Stop with or without findings', async t => {
  for (const profile of ['standard', 'ultra']) {
    for (const outcome of ['passed', 'findings']) {
      const { cwd, send, nativeHome } = project(t);
      await send('UserPromptSubmit');
      put(cwd, 'app.mjs', lines(80, 'updated'));
      const evidence = reviewFixture(t, cwd, outcome, 'HEAD', nativeHome, { strategy: 'lenses', profile });
      const recorded = invokeReview(t, cwd, outcome, 'gate', 'one', nativeHome, evidence);
      assert.equal(recorded.status, 0, profile + ' ' + outcome + ': ' + recorded.stderr);
      assert.deepEqual(await send('Stop'), {});
    }
  }
});

test('lens review recording rejects invalid stage sequences, reports and material seals', async t => {
  const { cwd, send, nativeHome } = project(t);
  await send('UserPromptSubmit');
  put(cwd, 'app.mjs', lines(80, 'updated'));
  const lenses = ['lens-adversarial', 'lens-contracts', 'lens-rules-tests'];
  const cases = [
    { label: 'missing lens', stages: lenses.slice(0, 2) },
    { label: 'missing gap', profile: 'ultra', stages: lenses },
    { label: 'wrong profile', profile: 'other' },
    { label: 'extra stage', stages: [...lenses, 'gap-logic'] },
    { label: 'unneeded verify', stages: [...lenses, 'verify'] },
    { label: 'missing verify despite rejected report', candidates: [{ id: 'L1-1' }], stages: lenses },
    { label: 'substituted archived stage', archivedStages: { 'lens-adversarial': 'lens-contracts' } },
    { label: 'late verify', outcome: 'findings', stages: [...lenses, 'gap-logic', 'verify'] },
    { label: 'mismatched report', outcome: 'findings', file: 'findings.json', mutate: report => {
      report.findings[0].id = 'changed';
    } },
    { label: 'tampered seal', file: 'metrics.json', mutate: metrics => {
      metrics.case_fingerprint['contract.md'] = '0'.repeat(64);
    } },
  ];
  for (const { label, outcome = 'passed', file, mutate, ...options } of cases) {
    const evidence = reviewFixture(t, cwd, outcome, 'HEAD', nativeHome, { strategy: 'lenses', ...options });
    if (file) {
      const document = JSON.parse(get(evidence, file));
      mutate(document);
      put(evidence, file, document);
    }
    const recorded = invokeReview(t, cwd, outcome, 'gate', 'one', nativeHome, evidence);
    assert.equal(recorded.status, 2, label + ': ' + recorded.stderr);
  }
  assert.equal((await send('Stop')).decision, 'block');
});

test('sharded standard and ultra review evidence satisfies Stop for both outcomes', async t => {
  const { cwd, send, nativeHome } = project(t);
  await send('UserPromptSubmit');
  for (const [profile, shardCount] of [['standard', 2], ['ultra', 3]]) {
    for (const outcome of ['passed', 'findings']) {
      put(cwd, 'app.mjs', lines(80, profile + outcome));
      const options = { strategy: 'lenses', profile, shardCount };
      if (outcome === 'findings' || profile === 'ultra') {
        options.candidates = Array.from({ length: 20 }, (_, i) => ({ id: 'SH1-' + (i + 1) }));
        options.verifyStages = ['verify-1', 'verify-2'];
        if (outcome === 'findings') options.findings = [options.candidates.at(-1), options.candidates[0]];
      }
      const evidence = reviewFixture(t, cwd, outcome, 'HEAD', nativeHome, options);
      const recorded = invokeReview(t, cwd, outcome, 'gate', 'one', nativeHome, evidence);
      assert.equal(recorded.status, 0, profile + ' ' + outcome + ': ' + recorded.stderr);
      assert.deepEqual(await send('Stop'), {});
    }
  }
});

test('review recording binds the shard count in the native archives', async t => {
  const { cwd, send, nativeHome } = project(t);
  await send('UserPromptSubmit');
  put(cwd, 'app.mjs', lines(80, 'updated'));
  const discovery = ['shard-1', 'shard-2', 'shard-3', 'lens-contracts', 'lens-rules-tests'];
  for (const [label, stages, count] of [
    ['omitted third shard', discovery.filter(stage => stage !== 'shard-3'), 2],
    ['sharded archive presented as unsharded', ['lens-adversarial', ...discovery.slice(3)], 1],
  ]) {
    const evidence = reviewFixture(t, cwd, 'passed', 'HEAD', nativeHome, { strategy: 'lenses', shardCount: 3, stages });
    const metrics = JSON.parse(get(evidence, 'metrics.json'));
    put(evidence, 'metrics.json', { ...metrics, shard_count: count, shards: metrics.shards.slice(0, count) });
    const recorded = invokeReview(t, cwd, 'passed', 'gate', 'one', nativeHome, evidence);
    assert.equal(recorded.status, 2, label + ': ' + recorded.stderr);
  }
});

test('review recording enforces canonical decisions in single and parallel verification', async t => {
  const { cwd, send, nativeHome } = project(t);
  await send('UserPromptSubmit');
  put(cwd, 'app.mjs', lines(80, 'updated'));
  const canonical = { id: 'fixture' };
  const duplicate = { id: 'duplicate' };
  const candidates = [canonical, duplicate, { id: 'SH2-1' }];
  const accept = (id, canonical_id = id) => ({ id, decision: 'accept', canonical_id });
  const reject = (id, canonical_id = '-') => ({ id, decision: 'reject', canonical_id });
  const valid = [accept(canonical.id), accept(duplicate.id, canonical.id)];
  const cases = [
    ['valid consolidation', valid, 0],
    ['rejected finding included', [reject(canonical.id), reject(duplicate.id)], 2],
    ['missing canonical self-accept', [reject(canonical.id), accept(duplicate.id, canonical.id)], 2],
    ['rejection references a canonical finding', [accept(canonical.id), reject(duplicate.id, canonical.id)], 2],
    ['invalid decision', [accept(canonical.id), { ...reject(duplicate.id), decision: 'skip' }], 2],
    ['invalid canonical reference type', [accept(canonical.id), reject(duplicate.id, null)], 2],
  ];
  for (const [label, decisions, status] of cases) {
    for (const verifyStages of [['verify'], ['verify-1', 'verify-2']]) {
      const stage = verifyStages[0];
      const evidence = reviewFixture(t, cwd, 'findings', 'HEAD', nativeHome, {
        strategy: 'lenses', shardCount: 2, candidates, findings: [canonical], verifyStages,
        verifyResponses: { [stage]: { accepted_findings: [canonical],
          decisions: stage === 'verify' ? [...decisions, reject('SH2-1')] : decisions } },
      });
      const recorded = invokeReview(t, cwd, 'findings', 'gate', 'one', nativeHome, evidence);
      assert.equal(recorded.status, status, label + ' (' + stage + '): ' + recorded.stderr);
    }
  }
});

test('sharded review recording rejects invalid shard and verification evidence', async t => {
  const { cwd, send, nativeHome } = project(t);
  await send('UserPromptSubmit');
  put(cwd, 'app.mjs', lines(80, 'updated'));
  const discovery = ['shard-1', 'shard-2', 'lens-contracts', 'lens-rules-tests'];
  const cases = [
    { label: 'mismatched shard metadata', count: 3 },
    ...[0, -1, 1.5, '2'].map(count => ({ label: 'invalid shard count ' + count, count })),
    { label: 'missing shard stage', stages: [...discovery.slice(1), 'verify-1', 'verify-2'] },
    { label: 'wrong archived shard stage', archivedStages: { 'shard-2': 'shard-1' } },
    { label: 'wrong archived verifier shard count', archivedShards: { 'verify-2': 3 } },
    { label: 'extra verify-3', verifyStages: ['verify-1', 'verify-2', 'verify-3'] },
    { label: 'missing verify-2', verifyStages: ['verify-1'] },
    { label: 'missing candidate decision', verifyResponses: { 'verify-2': { accepted_findings: [], decisions: [] } } },
    { label: 'missing decisions array', verifyResponses: { 'verify-2': { accepted_findings: [] } } },
    { label: 'duplicate candidate decision', verifyResponses: {
      'verify-2': { accepted_findings: [], decisions: [{ id: 'fixture', decision: 'reject', canonical_id: '-' }, { id: 'SH2-1', decision: 'reject', canonical_id: '-' }] },
    } },
    { label: 'different combined findings', verifyResponses: {
      'verify-1': { accepted_findings: [{ id: 'fixture', title: 'Altered' }], decisions: [{ id: 'fixture', decision: 'accept', canonical_id: 'fixture' }] },
    } },
  ];
  for (const { label, count, ...options } of cases) {
    const evidence = reviewFixture(t, cwd, 'findings', 'HEAD', nativeHome, {
      strategy: 'lenses', shardCount: 2, candidates: [{ id: 'fixture' }, { id: 'SH2-1' }],
      verifyStages: ['verify-1', 'verify-2'], ...options,
    });
    if (count !== undefined) {
      const metrics = JSON.parse(get(evidence, 'metrics.json'));
      put(evidence, 'metrics.json', { ...metrics, shard_count: count });
    }
    const recorded = invokeReview(t, cwd, 'findings', 'gate', 'one', nativeHome, evidence);
    assert.equal(recorded.status, 2, label + ': ' + recorded.stderr);
  }
  assert.equal((await send('Stop')).decision, 'block');
});

test('disabling the review gate does not disable the requirements decision before an edit', async t => {
  const { cwd } = project(t);
  put(cwd, '.geppetto/config.json', { ...config(), hooks: { reviewGate: { enabled: false } } });
  const context = { cwd, session_id: 'requirements', turn_id: 'one' };
  await handleEvent({ ...context, hook_event_name: 'UserPromptSubmit' });
  const result = await handleEvent({ ...context, hook_event_name: 'PreToolUse', tool_name: 'apply_patch',
    tool_input: { patch: '*** Begin Patch\n*** Delete File: app.mjs\n*** End Patch' } });
  assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny');
});

test('tool and Stop diagnostic rows survive a broken turn state and bound repeated failures', async t => {
  const { cwd, send } = project(t); await send('UserPromptSubmit');
  put(cwd, turnStatePath(cwd, 'gate'), '{');
  for (const hook_event_name of ['PreToolUse', 'PostToolUse', 'Stop', 'PreToolUse']) {
    await send(hook_event_name, { tool_name: 'apply_patch', tool_input: {} });
  }
  const events = get(cwd, projectDataPath(cwd, 'hook-events.jsonl')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.filter(row => row.hook === 'completion' && row.status === 'error')
    .map(row => [row.phase, row.turnId, row.epoch]), [
    ['PreToolUse', 'one', null], ['PostToolUse', 'one', null], ['Stop', 'one', null],
  ]);
  const audit = await metricsAudit(cwd, { key: 'fixture', execute: () => ({ status: 1 }) });
  const coverage = audit.compliance.find(row => row.harness === 'codex');
  assert.equal(coverage.failedEvaluations, 3);
  assert.equal(coverage.unjoinedEvaluations, 3);
  assert.equal(coverage.eligibleStopTurns, 1);
});
