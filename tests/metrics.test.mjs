import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, invoke, put } from './helpers.mjs';
import { handleEvent } from '../skills/geppetto-adopt/scripts/hook.mjs';
import { projectRecords } from '../skills/geppetto-adopt/scripts/project-records.mjs';

test('native hook pairs completed calls once and drops command arguments', async t => {
  const cwd = fixture(t);
  put(cwd, '.geppetto/config.json', { hooks: { learnNudge: { enabled: false } } });
  const event = { cwd, session_id: 'session', turn_id: 'turn', tool_name: 'exec_command',
    tool_input: { cmd: 'npm test -- sample.test.js --test-name-pattern=private-test' } };
  const send = (hook_event_name, tool_use_id, at, extra = {}) =>
    handleEvent({ ...event, hook_event_name, tool_use_id, ...extra }, { now: () => at, home: cwd });
  await send('PreToolUse', 'test', 0);
  await send('PreToolUse', 'other', 10, { tool_input: { cmd: 'bun --version' } });
  await send('PostToolUse', 'other', 20);
  await send('PostToolUse', 'missing', 30);
  await send('PostToolUse', 'test', 80, { tool_response: 'Process exited with code 1' });
  await send('PostToolUse', 'test', 90);
  const rows = await projectRecords(cwd, 'metrics');
  assert.deepEqual(rows.map(({ kind, key, scoped, durationMs, exit, ok }) =>
    ({ kind, key, scoped, durationMs, exit, ok })),
  [{ kind: 'suite', key: 'npm test', scoped: true, durationMs: 80, exit: 1, ok: false }]);
  assert.doesNotMatch(JSON.stringify(rows), /private-test|sample\.test/);
  const audit = invoke('audit.mjs', ['--metrics', '--json', '--key', 'npm test'], { cwd });
  assert.equal(audit.status, 0, audit.stderr);
  const report = JSON.parse(audit.stdout);
  assert.equal(report.keys[0].medianMs, 80);
  assert.equal(report.coverage.turns.status, 'missing');
});

test('report merges overlapping host spans while retaining elapsed resource time and decision evidence', async t => {
  const cwd = fixture(t);
  const { metricsAudit } = await import('../skills/geppetto-adopt/scripts/metrics-audit.mjs');
  const timestamp = '2026-11-18T00:05:05.000Z';
  const span = (startedAt, endedAt, host) => ({ ts: timestamp, kind: 'delegate', key: 'wait_agent', host,
    startedAt, endedAt, durationMs: endedAt - startedAt });
  put(cwd, '.geppetto/metrics.jsonl', [span(0, 100, 'a'), span(50, 120, 'a'), span(50, 100, 'b')].map(row => JSON.stringify(row)).join('\n'));
  put(cwd, '.geppetto/turns.jsonl', JSON.stringify({ ts: timestamp, turnId: 'decision', decisions: [
    { requestedAt: '2026-11-18T00:00:00Z', decidedAt: '2026-11-18T00:03:45.430Z' }, {},
  ] }));
  const execute = (program, args) => {
    assert.equal(program, 'gh');
    assert.ok(args.includes('merged'));
    return { status: 0, stdout: JSON.stringify([{ number: 1, createdAt: '2026-11-17T00:05:05Z', mergedAt: timestamp }]) };
  };
  const report = await metricsAudit(cwd, { now: Date.parse('2026-11-19'), execute });
  assert.deepEqual(report.delegates, { wallMs: 170, resourceMs: 220, count: 3 });
  assert.deepEqual(report.topTimeSinks, [{ key: 'wait_agent', wallMs: 170, resourceMs: 220 }]);
  assert.equal(report.keys[0].medianMs, 70);
  assert.equal(report.keys[0].p90Ms, 100);
  assert.equal(report.keys[0].lastWeek.count, 3);
  assert.equal(report.keys[0].previousWeek.count, 0);
  assert.equal(report.decisionWaits[0].durationMs, 225430);
  assert.equal(report.decisionWaits[0].missing, 1);
  assert.equal(report.prCycle.medianMs, 86400000);
});

test('normalizes suites after setup and retains only Git operation names', async () => {
  const { metricOperation } = await import('../skills/geppetto-adopt/scripts/metrics.mjs');
  const operation = cmd => metricOperation({ tool_name: 'exec_command', tool_input: { cmd } });
  for (const [command, key] of [
    ['cd app && npm test -- file.test.js', 'npm test'],
    ['python -m pytest tests/test_sample.py', 'python -m pytest'],
    ['npx vitest run tests/a.test.ts', 'npx vitest run'],
  ]) assert.deepEqual(operation(command), { key, kind: 'suite', scoped: true, always: true });
  assert.equal(operation('git -C private-folder status').key, 'git status');
  assert.equal(operation('gh issue private-argument').key, 'gh issue');
  assert.equal(operation('npm --registry private-host test').key, 'npm test');
  assert.equal(operation('pnpm --dir confidential test').key, 'pnpm test');
  assert.equal(operation('npm --unknown private-host test').key, 'npm');
  assert.equal(operation('npm test&'), undefined);
  assert.equal(operation('npm test & echo done'), undefined);
  assert.equal(operation('npm test > file 2>&1').scoped, false);
});
