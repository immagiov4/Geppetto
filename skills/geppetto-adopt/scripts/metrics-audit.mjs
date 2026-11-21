import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { redactValue } from './signal.mjs';
import { timedMetric } from './metric-anomalies.mjs';
import { resourceHost, sizeRoot } from './resource-metrics.mjs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { appendRecord, cli, exists, isMain, jsonFile, run, userHome, UsageError } from './common.mjs';
import { projectDataPath, projectRecords, worktreePaths } from './project-records.mjs';

const auditTimeout = 115000;
const executeFile = promisify(execFile);
const weekMs = 7 * 86400000;
const sum = values => values.reduce((total, value) => total + value, 0);
function distribution(values) {
  const ordered = values.toSorted((a, b) => a - b), count = ordered.length;
  return { count, medianMs: count ? (ordered[Math.floor((count - 1) / 2)] + ordered[Math.floor(count / 2)]) / 2 : null,
    p90Ms: ordered[Math.ceil(count * 0.9) - 1] ?? null, maxMs: ordered.at(-1) ?? null, totalMs: sum(ordered) };
}

function mergedWall(rows) {
  const hosts = Map.groupBy(rows, row => row.host);
  return sum([...hosts.values()].map(spans => {
    let end = -Infinity, total = 0;
    for (const { startedAt, endedAt } of spans.toSorted((a, b) => a.startedAt - b.startedAt)) {
      total += Math.max(0, endedAt - Math.max(startedAt, end));
      end = Math.max(end, endedAt);
    }
    return total;
  }));
}

async function journal(project, name) {
  const rows = await projectRecords(project, name);
  const present = rows.length || await exists(projectDataPath(project, `${name}.jsonl`));
  return { rows, coverage: { status: present ? 'available' : 'missing', observed: rows.length, first: rows[0]?.ts ?? null, last: rows.at(-1)?.ts ?? null } };
}

const waitMs = (start, end) => {
  const elapsed = Date.parse(end) - Date.parse(start);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
};

async function auditSizes(project, rows, now, home) {
  const { metrics } = await jsonFile(resolve(project, '.geppetto/config.json'), {});
  const gitData = projectDataPath(project, '');
  const gitRoots = gitData === resolve(project, '.geppetto') ? [] : [dirname(gitData), ...worktreePaths(project)];
  const t3Root = resolve(home, '.t3/worktrees'), containers = new Set();
  const individualRoots = gitRoots.filter(path => {
    const relativePath = relative(t3Root, path);
    const parts = relativePath.split(sep);
    if (isAbsolute(relativePath) || parts.length < 2 || parts[0] === '..') return true;
    containers.add(resolve(t3Root, parts[0]));
    return false;
  });
  const roots = new Set([...individualRoots, ...containers,
    resolve(home, '.geppetto'), resolve(home, '.codex/plugins/cache'), resolve(home, '.claude/plugins/cache'),
    ...[process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR].filter(Boolean).map(path => resolve(path, 'plugins/cache')),
    ...(metrics?.artifacts ?? []).map(path => resolve(project, path))]);
  const ts = new Date(now).toISOString(), paths = [...roots].sort();
  const deadline = performance.now() + 90000, sizes = new Array(paths.length);
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < paths.length) {
      const index = next++, path = paths[index];
      const remaining = Math.floor(deadline - performance.now());
      const result = remaining > 0 ? await sizeRoot(path, remaining, containers.has(path))
        : { status: 'partial', bytes: 0, skipped: path, reason: 'deadline' };
      sizes[index] = redactValue({ path, ...result });
    }
  }));
  await appendRecord(project, 'metrics', { kind: 'resource', key: 'disk-size', host: resourceHost, ts, sizes });
  const previous = new Map(rows.filter(row => row.key === 'disk-size' && row.host === resourceHost && Date.parse(row.ts) >= now - 2 * weekMs && Date.parse(row.ts) < now - weekMs)
    .flatMap(row => row.sizes.filter(size => size.status === 'complete').map(size => [size.path, size.bytes])));
  return sizes.map(size => ({ ...size, weekChangeBytes: size.status === 'complete' && previous.has(size.path) ? size.bytes - previous.get(size.path) : null }));
}

function gateCompliance(journals, start) {
  const tagged = journals.flatMap(({ name, rows }) => rows
    .filter(row => Date.parse(row.ts) >= start)
    .map(row => ({ row, name })));
  const byHost = Map.groupBy(tagged, ({ row }) => JSON.stringify([row.host ?? null, row.harness ?? null]));
  return [...byHost].map(([hostKey, entries]) => {
    const [host, harness] = JSON.parse(hostKey);
    const identifiable = entries.filter(({ row }) => row.host && row.harness && row.sessionId && row.turnId && row.epoch);
    const byEpoch = Map.groupBy(identifiable, ({ row }) => JSON.stringify([row.sessionId, row.turnId, row.epoch]));
    let joined = 0, checkedEdits = 0, uncheckedEdits = 0, editOverrides = 0;
    let editEpochs = 0, stopEpochs = 0, unresolvedStops = 0, stopRetries = 0, stopOverrides = 0;
    for (const epoch of byEpoch.values()) {
      if (new Set(epoch.map(({ name }) => name)).size > 1) joined += epoch.length;
      const dispositions = epoch.map(({ row }) => row).filter(row => row.disposition);
      const edits = dispositions.filter(row => row.hook === 'turnGate');
      if (edits.length) editEpochs++;
      checkedEdits += edits.filter(row => row.disposition === 'decision').length;
      uncheckedEdits += edits.filter(row => row.disposition === 'unchecked').length;
      editOverrides += edits.filter(row => row.disposition === 'override').length;
      const stops = dispositions.filter(row => ['learningGate', 'reviewGate'].includes(row.hook));
      if (stops.length) stopEpochs++;
      stopRetries += new Set(stops.filter(row => row.retry && row.stopAttemptId).map(row => row.stopAttemptId)).size;
      if (stops.some(row => row.disposition === 'override')) stopOverrides++;
      if (['learningGate', 'reviewGate'].some(hook => ['denied', 'retry-denied', 'unresolved']
        .includes(stops.findLast(row => row.hook === hook)?.disposition))) unresolvedStops++;
    }
    return { host, harness, records: entries.length, identifiable: identifiable.length, joined,
      editEpochs, checkedEdits, uncheckedEdits, editOverrides, stopEpochs, unresolvedStops, stopRetries, stopOverrides };
  }).sort((a, b) => String(a.host).localeCompare(String(b.host)) || String(a.harness).localeCompare(String(b.harness)));
}

export async function metricsAudit(project, { since, key, now = Date.now(), execute = run, home = userHome() } = {}) {
  const start = since === undefined ? -Infinity : Date.parse(since);
  if (Number.isNaN(start)) throw new UsageError('--since must be an ISO date.');
  const metrics = await journal(project, 'metrics'), turns = await journal(project, 'turns');
  const [events, reviews] = await Promise.all([journal(project, 'hook-events'), journal(project, 'reviews')]);
  const compliance = gateCompliance([{ name: 'metrics', rows: metrics.rows }, { name: 'turns', rows: turns.rows }, { name: 'events', rows: events.rows }, { name: 'reviews', rows: reviews.rows }], start);
  const resources = metrics.rows.filter(row => row.kind === 'resource' && row.key === 'stop' && Date.parse(row.ts) >= start && (!key || row.key === key));
  const sizes = key && key !== 'disk-size' ? [] : await auditSizes(project, metrics.rows, now, home).catch(error => [{ status: 'unavailable', reason: error.code ?? 'resource roots unavailable' }]);
  const observed = metrics.rows.filter(row => Date.parse(row.ts) >= start && (!key || row.key === key));
  const rows = observed.filter(timedMetric);
  const reminderId = row => JSON.stringify([row.sessionId, row.turnId, row.key]);
  const diagnosed = new Set(metrics.rows.filter(row => row.kind === 'diagnosis').map(reminderId));
  const delivered = observed.filter(row => row.kind === 'reminder');
  const matched = delivered.filter(row => diagnosed.has(reminderId(row))).length;
  const reminders = { delivered: delivered.length, diagnosed: matched, pending: delivered.length - matched };
  const groups = Map.groupBy(rows, row => row.key);
  const keys = [...groups].map(([key, group]) => {
    const times = group.map(row => row.durationMs);
    return { key, ...distribution(times), scoped: group.filter(row => row.scoped).length,
      lastWeek: distribution(group.filter(row => Date.parse(row.ts) >= now - weekMs && Date.parse(row.ts) <= now).map(row => row.durationMs)),
      previousWeek: distribution(group.filter(row => Date.parse(row.ts) >= now - 2 * weekMs && Date.parse(row.ts) < now - weekMs).map(row => row.durationMs)) };
  }).sort((a, b) => b.totalMs - a.totalMs || a.key.localeCompare(b.key));
  const topTimeSinks = keys.map(({ key, totalMs }) => {
    const group = groups.get(key), spans = group.filter(row => row.kind === 'delegate');
    return { key, wallMs: mergedWall(spans) + sum(group.filter(row => row.kind !== 'delegate').map(row => row.durationMs)), resourceMs: totalMs };
  }).sort((a, b) => b.wallMs - a.wallMs || a.key.localeCompare(b.key)).slice(0, 10);
  const delegates = rows.filter(row => row.kind === 'delegate');
  const decisionWaits = turns.rows.filter(row => Date.parse(row.ts) >= start).map(row => {
    const waits = (row.decisions ?? []).map(pair => waitMs(pair.requestedAt, pair.decidedAt));
    const observed = waits.filter(wait => wait !== null);
    return { ts: row.ts, turnId: row.turnId, sessionId: row.sessionId, durationMs: observed.length ? sum(observed) : null,
      decisions: observed.length, missing: waits.length - observed.length };
  }).sort((a, b) => (b.durationMs ?? -1) - (a.durationMs ?? -1));
  const result = execute('gh', ['pr', 'list', '--state', 'merged', '--limit', '100', '--json', 'number,createdAt,mergedAt,changedFiles,additions,deletions'], { cwd: project });
  let prs = null;
  if (result.status === 0) {
    try { prs = JSON.parse(result.stdout).map(pr => ({ number: pr.number, ts: pr.mergedAt, changedFiles: pr.changedFiles ?? null, additions: pr.additions ?? null, deletions: pr.deletions ?? null, durationMs: waitMs(pr.createdAt, pr.mergedAt) })); }
    catch { /* An unreadable host response leaves coverage unknown. */ }
  }
  const prCycle = prs?.filter(row => Date.parse(row.ts) >= start) ?? [];
  return { project, since: since ?? null, key: key ?? null, keys, topTimeSinks,
    delegates: { wallMs: mergedWall(delegates), resourceMs: sum(delegates.map(row => row.durationMs)), count: delegates.length },
    resources, sizes, compliance, reminders, mergedPrs: prCycle, decisionWaits, prCycle: prs ? distribution(prCycle.flatMap(row => row.durationMs === null ? [] : [row.durationMs])) : null,
    coverage: { metrics: metrics.coverage, turns: turns.coverage, 'hook events': events.coverage, prs: { status: prs ? 'available' : 'unknown', observed: prs?.length ?? 0, limit: 100 } } };
}

export async function boundedMetricsAudit(project, { since, key } = {}) {
  try {
    const { stdout } = await executeFile(process.execPath,
      [fileURLToPath(import.meta.url), project, JSON.stringify({ since, key })],
      { timeout: auditTimeout, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    if (error.code === 2) throw new UsageError(error.stderr.trim());
    throw new Error(error.killed ? 'Metrics audit deadline exceeded.' : error.stderr?.trim() || 'Metrics audit failed.');
  }
}
if (isMain(import.meta.url)) {
  const [, , project, options] = process.argv;
  await cli(async () => { console.log(JSON.stringify(await metricsAudit(project, JSON.parse(options)))); });
}

export function printMetrics(report) {
  console.log(`Geppetto metrics: ${report.project}`);
  for (const [source, coverage] of Object.entries(report.coverage)) {
    console.log(`${source}: ${coverage.status}, ${coverage.observed} observed${coverage.limit ? ` (latest ${coverage.limit} maximum)` : ''}${coverage.first ? `, ${coverage.first} to ${coverage.last}` : ''}`);
  }
  for (const row of report.keys) {
    console.log(`${row.key}: ${row.count} calls, median ${row.medianMs} ms, p90 ${row.p90Ms} ms, max ${row.maxMs} ms, total ${row.totalMs} ms, scoped ${row.scoped}; last 7 days ${row.lastWeek.totalMs} ms (${row.lastWeek.count}) vs previous 7 ${row.previousWeek.totalMs} ms (${row.previousWeek.count})`);
  }
  for (const row of report.compliance) {
    console.log(`Gate evidence ${row.host ?? 'unknown host'}/${row.harness ?? 'unknown harness'}: ${row.joined}/${row.records} linked (${row.identifiable} identifiable), ${row.uncheckedEdits} unchecked edits across ${row.editEpochs} edit epochs, ${row.unresolvedStops}/${row.stopEpochs} unresolved Stop epochs, ${row.stopRetries} retry attempts, ${row.editOverrides} edit and ${row.stopOverrides} Stop overrides`);
  }
  if (report.reminders.delivered) console.log(`Timing reminders: ${report.reminders.diagnosed}/${report.reminders.delivered} diagnosed; ${report.reminders.pending} pending`);
  for (const sink of report.topTimeSinks) console.log(`Time sink ${sink.key}: ${sink.wallMs} ms wall, ${sink.resourceMs} ms summed`);
  const { delegates, decisionWaits, prCycle } = report;
  console.log(`Delegate spans: ${delegates.count}, merged host wall ${delegates.wallMs} ms, summed resource ${delegates.resourceMs} ms`);
  console.log(`Decision waits: ${decisionWaits.length} recorded turns`);
  for (const row of decisionWaits.slice(0, 10)) console.log(`${row.ts} ${row.turnId}: ${row.durationMs === null ? 'unknown' : `${row.durationMs / 1000} s`} (${row.decisions} observed decisions, ${row.missing} missing)`);
  for (const row of report.resources.slice(-10)) console.log(`Stop resources ${row.ts}: ${JSON.stringify({ worktreeCount: row.worktreeCount, volumes: row.volumes, processes: row.processes })}`);
  for (const size of report.sizes) console.log(`Disk size: ${JSON.stringify(size)}`);
  for (const pr of report.mergedPrs) console.log(`PR #${pr.number}: ${pr.durationMs ?? 'unknown'} ms, ${pr.changedFiles ?? '?'} files, +${pr.additions ?? '?'} -${pr.deletions ?? '?'}`);
  console.log(prCycle ? `Merged PR cycle: ${prCycle.count} observed, median ${prCycle.medianMs ?? 'unknown'} ms, p90 ${prCycle.p90Ms ?? 'unknown'} ms, max ${prCycle.maxMs ?? 'unknown'} ms` : 'Merged PR cycle: unknown');
}
