import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, git, invoke, put } from './helpers.mjs';
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
    return { status: 0, stdout: JSON.stringify([{ number: 1, changedFiles: 3, additions: 10, deletions: 2, createdAt: '2026-11-17T00:05:05Z', mergedAt: timestamp }]) };
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
  assert.deepEqual(report.mergedPrs[0], { number: 1, ts: timestamp, changedFiles: 3, additions: 10, deletions: 2, durationMs: 86400000 });
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

test('groups new processes and bounds unavailable snapshots', async () => {
  const { processDelta, resourceProbe } = await import('../skills/geppetto-adopt/scripts/resource-metrics.mjs');
  const baseline = [[10, 1, 'old', 'node', 1024]];
  assert.deepEqual(processDelta(baseline, [...baseline, [11, 1, 'new', 'node', 2048], [12, 1, 'new', 'chrome', 4096], [13, 11, 'new', 'bun', 8192]], 11), [{ family: 'browser', count: 1, residentBytes: 4096 }]);
  assert.throws(() => resourceProbe({ execute: () => ({ status: null, error: { code: 'ETIMEDOUT' } }) }), /ETIMEDOUT/);
});

test('directory measurements report a partial result when the budget expires', async t => {
  const { sizeRoot } = await import('../skills/geppetto-adopt/scripts/resource-metrics.mjs');
  const cwd = fixture(t);
  put(cwd, 'artifact/file.txt', '12345');
  assert.deepEqual(await sizeRoot(cwd + '/artifact'), { status: 'complete', bytes: 5 });
  const partial = await sizeRoot(cwd + '/artifact', 0);
  assert.equal(partial.status, 'partial');
  assert.ok(partial.skipped);
});

test('session hooks record resource rows and fail open once on a failed probe', async t => {
  const cwd = fixture(t);
  assert.equal(git(cwd, ['init']).status, 0);
  const event = { cwd, session_id: 'resources' };
  const runCommand = (command, args) => {
    if (command === 'git') return git(cwd, args);
    return { status: 0, stdout: '' };
  };
  await handleEvent({ ...event, hook_event_name: 'SessionStart' }, { home: cwd, runCommand });
  await handleEvent({ ...event, hook_event_name: 'Stop' }, { home: cwd, runCommand });
  const [row] = await projectRecords(cwd, 'metrics');
  assert.ok(row, JSON.stringify(await projectRecords(cwd, 'hook-events')));
  assert.equal(row.kind, 'resource');
  assert.equal(row.worktreeCount, 1);
  assert.deepEqual(Object.keys(row.volumes).sort(), ['home', 'project', 'temp']);
  assert.ok(row.volumes.project.totalBytes > 0);
  assert.deepEqual(row.processes, []);
  const timeout = () => ({ status: null, error: { code: 'ETIMEDOUT' } });
  const result = await handleEvent({ ...event, hook_event_name: 'Stop' }, { home: cwd, runCommand: timeout });
  assert.equal(result.decision, undefined);
  assert.equal((await projectRecords(cwd, 'metrics')).length, 1);
  const events = await projectRecords(cwd, 'hook-events');
  assert.equal(events.filter(row => row.hook === 'metrics' && row.error === 'ETIMEDOUT').length, 1);
});

test('audit journals configured artifacts and compares the preceding week', async t => {
  const cwd = fixture(t);
  const { metricsAudit } = await import('../skills/geppetto-adopt/scripts/metrics-audit.mjs');
  const { resolve } = await import('node:path');
  const artifact = resolve(cwd, 'artifact');
  put(cwd, '.geppetto/config.json', { metrics: { artifacts: ['artifact'] } });
  put(cwd, 'artifact/file.txt', 'abc');
  const execute = () => ({ status: 0, stdout: '[]' });
  await metricsAudit(cwd, { now: Date.parse('2026-11-12'), execute, home: cwd });
  put(cwd, 'artifact/file.txt', 'abcdef');
  const report = await metricsAudit(cwd, { now: Date.parse('2026-11-21'), execute, home: cwd });
  assert.deepEqual(report.sizes.find(size => size.path === artifact), { path: artifact, status: 'complete', bytes: 6, weekChangeBytes: 3 });
  assert.equal((await projectRecords(cwd, 'metrics')).filter(row => row.key === 'disk-size').length, 2);
});

test('worktree container reports its total and ranks children by size', async t => {
  const { sizeRoot } = await import('../skills/geppetto-adopt/scripts/resource-metrics.mjs');
  const cwd = fixture(t);
  put(cwd, 'worktrees/a/file', '12');
  put(cwd, 'worktrees/b/file', '12345');
  put(cwd, 'worktrees/metadata', '1');
  assert.deepEqual(await sizeRoot(cwd + '/worktrees', 5000, true), {
    status: 'complete', bytes: 8, largestChildren: [{ name: 'b', bytes: 5 }, { name: 'a', bytes: 2 }],
  });
});

test('audit lists nested registered T3 worktrees only through their container', async t => {
  const cwd = fixture(t);
  const { metricsAudit } = await import('../skills/geppetto-adopt/scripts/metrics-audit.mjs');
  const { resolve } = await import('node:path');
  assert.equal(git(cwd, ['init']).status, 0);
  assert.equal(git(cwd, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'base']).status, 0);
  const container = resolve(cwd, '.t3/worktrees/project');
  const nested = resolve(container, 'parent/nested');
  assert.equal(git(cwd, ['worktree', 'add', '--detach', nested]).status, 0);
  const report = await metricsAudit(cwd, { home: cwd, execute: () => ({ status: 0, stdout: '[]' }) });
  assert.equal(report.sizes.some(size => size.path === nested), false);
  assert.equal(report.sizes.find(size => size.path === container)?.largestChildren[0].name, 'parent');
});
