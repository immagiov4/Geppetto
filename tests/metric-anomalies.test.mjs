import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config, fixture, get, git, put } from './helpers.mjs';
import { learningEvent } from '../skills/geppetto-adopt/scripts/learn-nudge.mjs';
import { handleEvent } from '../skills/geppetto-adopt/scripts/hook.mjs';
import { metricAnomaly, metricBaselines, prTimingNote, recordMetricNote } from '../skills/geppetto-adopt/scripts/metric-anomalies.mjs';
import { metricsAudit } from '../skills/geppetto-adopt/scripts/metrics-audit.mjs';
import { projectDataPath } from '../skills/geppetto-adopt/scripts/project-records.mjs';

test('PostToolUse delivers one cold-start timing reminder per key and turn', async t => {
  const cwd = fixture(t);
  git(cwd, ['init', '-q']);
  put(cwd, '.geppetto/config.json', { ...config(), hooks: { learnNudge: { enabled: false }, signalLearning: { enabled: false } } });
  const event = { cwd, session_id: 'session', turn_id: 'turn', tool_name: 'Bash', tool_input: { command: 'git status' } };
  async function complete(id, start, duration) {
    await learningEvent({ ...event, tool_use_id: id, hook_event_name: 'PreToolUse' }, () => start);
    return learningEvent({ ...event, tool_use_id: id, hook_event_name: 'PostToolUse', tool_response: { exit_code: 0 } }, () => start + duration);
  }
  assert.deepEqual(await complete('fast', 1000, 59999), {});
  assert.match((await complete('slow', 75000, 60000)).hookSpecificOutput?.additionalContext ?? '', /git status/);
  assert.deepEqual(await complete('again', 160000, 61000), {});
  const rows = get(cwd, projectDataPath(cwd, 'metrics.jsonl')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row => row.kind === 'reminder').length, 1);
});

test('expectation takes precedence and warmed thresholds use only prior timed runs', () => {
  const key = 'git status';
  const baseline = metricBaselines([1000, 2000, 3000, 4000, 8000].map(durationMs => ({ key, kind: 'command', durationMs })))[key];
  assert.deepEqual(baseline, { n: 5, p50: 3000, p90: 8000 });
  assert.equal(metricAnomaly({ kind: 'command', durationMs: 10000 }, baseline), null);
  assert.equal(metricAnomaly({ kind: 'command', durationMs: 10001 }, baseline).rule, 'observed baseline');
  assert.equal(metricAnomaly({ kind: 'command', durationMs: 12000 }, baseline, { expectedMs: 13000, warnMs: 1000 }), null);
  assert.equal(metricAnomaly({ kind: 'command', durationMs: 12000 }, baseline, { warnMs: 1000 }).rule, 'approved threshold');
  assert.equal(metricAnomaly({ kind: 'delegate', durationMs: 599999 }, null), null);
});

test('a diagnosed reminder counts once and an investigation creates an efficiency signal', async t => {
  const cwd = fixture(t);
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.name', 'Fixture']);
  git(cwd, ['config', 'user.email', 'fixture@example.invalid']);
  put(cwd, '.geppetto/config.json', { ...config(), hooks: { learnNudge: { enabled: false }, signalLearning: { enabled: false } } });
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-qm', 'baseline']);
  const key = 'node', session = 'timing-session', turn = 'native-turn';
  const event = { cwd, session_id: session, turn_id: turn, tool_name: 'Bash', tool_input: { command: 'node --version' } };
  await handleEvent({ ...event, hook_event_name: 'UserPromptSubmit' });
  await recordMetricNote(cwd, { kind: 'expectation', key, expectedMs: 100 }, { session, turn });
  await learningEvent({ ...event, tool_use_id: 'call', hook_event_name: 'PreToolUse' }, () => 1000);
  await recordMetricNote(cwd, { kind: 'expectation', key, expectedMs: 500 }, { session, turn });
  const result = await learningEvent({ ...event, tool_use_id: 'call', hook_event_name: 'PostToolUse', tool_response: { exit_code: 0 } }, () => 1200);
  assert.match(result.hookSpecificOutput.additionalContext, /expectation: 100 ms/);
  const note = { kind: 'diagnosis', key, verdict: 'investigate', reason: 'The temporary drive took longer than expected to scan.' };
  assert.equal((await recordMetricNote(cwd, note, { session, turn })).verdict, 'investigate');
  assert.equal((await recordMetricNote(cwd, note, { session, turn })).duplicate, true);
  assert.equal(JSON.parse(get(cwd, projectDataPath(cwd, 'signals.jsonl'))).category, 'efficiency');
  const audit = await metricsAudit(cwd, { key, execute: () => ({ status: 1 }) });
  assert.deepEqual(audit.reminders, { delivered: 1, diagnosed: 1, pending: 0 });
  assert.equal(audit.keys[0].count, 1);
});

test('a successful PR merge adds one line using the recorded PR interval', async t => {
  const cwd = fixture(t);
  const event = { tool_name: 'Bash', tool_input: { command: 'gh pr merge 12 --squash' }, tool_response: { exit_code: 0 } };
  const note = await prTimingNote(cwd, event, { ok: true }, (program, args) => {
    assert.equal(program, 'gh');
    assert.equal(args[2], '12');
    return { status: 0, stdout: JSON.stringify({ number: 12, state: 'MERGED', createdAt: '2026-11-01T00:00:00Z', mergedAt: '2026-11-01T00:00:12Z' }) };
  });
  assert.match(note, /^Geppetto PR #12: 12000 ms elapsed .*0 recorded review rounds and 0 timing reminders in this worktree window\.$/);
  assert.equal(await prTimingNote(cwd, event, { ok: false }, () => assert.fail('failed merges use no host lookup')), '');
});
