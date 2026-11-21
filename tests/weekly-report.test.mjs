import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, get, git, put } from './helpers.mjs';
import { appendRecord } from '../skills/geppetto-adopt/scripts/common.mjs';
import { learningFileTool } from '../skills/geppetto-adopt/scripts/learner-tools.mjs';
import { handleEvent } from '../skills/geppetto-adopt/scripts/hook.mjs';
import { metricsAudit } from '../skills/geppetto-adopt/scripts/metrics-audit.mjs';
import { logReads } from '../skills/geppetto-adopt/scripts/hook-events.mjs';
import { latestWeeklyReport, newWeeklyDraft, publishWeeklyReport } from '../skills/geppetto-adopt/scripts/weekly-report.mjs';

const dayMs = 86_400_000;
const now = Date.parse('2026-11-21T15:00:00Z');
const snapshot = {
  project: 'weekly-fixture', since: new Date(now - 14 * dayMs).toISOString(), asOf: new Date(now).toISOString(),
  topTimeSinks: [{ key: 'node --test', wallMs: 900, resourceMs: 1200 }],
  keys: [{ key: 'node --test', lastWeek: { count: 2, totalMs: 900 }, previousWeek: { count: 1, totalMs: 500 } }],
  sizes: [{ status: 'complete', path: 'worktree', bytes: 12000, weekChangeBytes: null }],
  mergedPrs: [{ number: 8, changedFiles: 3, additions: 10, deletions: 3, durationMs: 35, ts: new Date(now - 7 * dayMs + 1800_000).toISOString() }],
  prCycle: { count: 1 }, decisionWaits: [{ ts: new Date(now - dayMs).toISOString(), durationMs: 6, decisions: 1 }], coverage: { prs: { status: 'available', observed: 1, limit: 100 } },
};
const proposal = { evidence: 'node --test took 900 ms this week.', procedure: 'Compare two identical test runs before changing the default.', decisionRule: 'Keep only if median duration decreases and failures remain unchanged.' };

test('weekly curation publishes measured trends and at most two written proposals', async t => {
  const root = fixture(t);
  git(root, ['init', '-q']);
  const draft = await newWeeklyDraft(root);
  await assert.rejects(learningFileTool(root, 'ProposeExperiments', { proposals: [proposal] }), /unavailable/);
  const weekly = { weeklyDraft: draft, maintenance: true };
  await assert.rejects(learningFileTool(root, 'ProposeExperiments', { proposals: [proposal, proposal, proposal] }, false, null, weekly), /two/);
  await learningFileTool(root, 'ProposeExperiments', { proposals: [proposal] }, false, null, weekly);
  const report = await publishWeeklyReport(root, snapshot, { draft, now: now + 3600_000 });
  const text = get(root, report);
  for (const part of ['2026-11-21', 'node --test', '900 ms', '500 ms', '12000', '#8', '6 ms', 'Keep only if', 'weekly-fixture', '1 in the latest seven days', '(up to 100)']) assert.ok(text.includes(part), part);
  assert.equal(await latestWeeklyReport(root), report);
  await publishWeeklyReport(root, { status: 'unavailable' }, { now: now + dayMs });
  assert.equal(await latestWeeklyReport(root), report);
});

test('SessionStart mentions overdue reports only, and actual reads have their own evidence', async t => {
  const root = fixture(t), home = fixture(t);
  git(root, ['init', '-q']);
  put(root, '.geppetto/config.json', { turnChecks: [], hooks: { learnNudge: { enabled: false } } });
  const event = { cwd: root, session_id: 'weekly', hook_event_name: 'SessionStart' };
  assert.doesNotMatch(JSON.stringify(await handleEvent(event, { home, now: () => now })), /weekly metrics report/);
  const recent = await publishWeeklyReport(root, snapshot, { now });
  assert.doesNotMatch(JSON.stringify(await handleEvent(event, { home, now: () => now + 8 * dayMs })), /weekly metrics report/);
  assert.match(JSON.stringify(await handleEvent(event, { home, now: () => now + 8 * dayMs + 1 })), /weekly metrics report/);
  const toolEvent = { ...event, hook_event_name: 'PostToolUse' };
  await logReads({ ...toolEvent, tool_name: 'exec_command',
    tool_input: { command: 'rg -l -F "' + recent + '" README.md' } }, { home });
  await logReads({ ...toolEvent, tool_name: 'exec_command',
    tool_input: { command: 'rg --hidden --files curation.log "' + recent + '"' } }, { home });
  const noSearchRead = await metricsAudit(root, { key: 'fixture', execute: () => ({ status: 1 }) });
  assert.equal(noSearchRead.weeklyReportReads.count, 0);
  const path = process.platform === 'win32' ? recent[0].toLowerCase() + recent.slice(1) : recent;
  await logReads({ ...toolEvent, tool_name: 'Read', tool_input: { file_path: path } }, { home });
  const observed = await metricsAudit(root, { key: 'fixture', execute: () => ({ status: 1 }) });
  assert.equal(observed.weeklyReportReads.count, 1);
  await logReads({ ...toolEvent, tool_name: 'Read', tool_input: { file_path: recent } }, { home });
  const rereads = await metricsAudit(root, { key: 'fixture', execute: () => ({ status: 1 }) });
  assert.equal(rereads.weeklyReportReads.count, 2);
  assert.equal(Object.keys(rereads.weeklyReportReads.reports).length, 1);
});

test('historical weekly totals exclude observations received after the fixed audit cutoff', async t => {
  const root = fixture(t);
  git(root, ['init', '-q']);
  const ts = new Date(now + 1000).toISOString();
  await appendRecord(root, 'metrics', { kind: 'command', key: 'fixture', durationMs: 37, ts });
  await appendRecord(root, 'hook-events', { hook: 'turnContext', injectedBytes: 300, ts });
  const execute = () => ({ status: 0, stdout: JSON.stringify([
    { number: 8, createdAt: new Date(now - dayMs).toISOString(), mergedAt: ts },
  ]) });
  const report = await metricsAudit(root, { key: 'fixture', now, execute });
  assert.deepEqual(report.keys, []);
  assert.equal(report.geppettoOverhead.injectedBytes, null);
  assert.deepEqual(report.mergedPrs, []);
});
