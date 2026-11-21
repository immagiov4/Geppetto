import { exists, run, UsageError } from './common.mjs';
import { projectDataPath, projectRecords } from './project-records.mjs';

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

export async function metricsAudit(project, { since, key, now = Date.now(), execute = run } = {}) {
  const start = since === undefined ? -Infinity : Date.parse(since);
  if (Number.isNaN(start)) throw new UsageError('--since must be an ISO date.');
  const metrics = await journal(project, 'metrics'), turns = await journal(project, 'turns');
  const rows = metrics.rows.filter(row => Date.parse(row.ts) >= start && (!key || row.key === key));
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
  const result = execute('gh', ['pr', 'list', '--state', 'merged', '--limit', '100', '--json', 'number,createdAt,mergedAt'], { cwd: project });
  let prs = null;
  if (result.status === 0) {
    try { prs = JSON.parse(result.stdout).map(pr => ({ number: pr.number, ts: pr.mergedAt, durationMs: waitMs(pr.createdAt, pr.mergedAt) })); }
    catch { /* An unreadable host response leaves coverage unknown. */ }
  }
  const prCycle = prs?.filter(row => Date.parse(row.ts) >= start) ?? [];
  return { project, since: since ?? null, key: key ?? null, keys, topTimeSinks,
    delegates: { wallMs: mergedWall(delegates), resourceMs: sum(delegates.map(row => row.durationMs)), count: delegates.length },
    decisionWaits, prCycle: prs ? distribution(prCycle.flatMap(row => row.durationMs === null ? [] : [row.durationMs])) : null,
    coverage: { metrics: metrics.coverage, turns: turns.coverage, prs: { status: prs ? 'available' : 'unknown', observed: prs?.length ?? 0, limit: 100 } } };
}

export function printMetrics(report) {
  console.log(`Geppetto metrics: ${report.project}`);
  for (const [source, coverage] of Object.entries(report.coverage)) {
    console.log(`${source}: ${coverage.status}, ${coverage.observed} observed${coverage.limit ? ` (latest ${coverage.limit} maximum)` : ''}${coverage.first ? `, ${coverage.first} to ${coverage.last}` : ''}`);
  }
  for (const row of report.keys) {
    console.log(`${row.key}: ${row.count} calls, median ${row.medianMs} ms, p90 ${row.p90Ms} ms, max ${row.maxMs} ms, total ${row.totalMs} ms, scoped ${row.scoped}; last 7 days ${row.lastWeek.totalMs} ms (${row.lastWeek.count}) vs previous 7 ${row.previousWeek.totalMs} ms (${row.previousWeek.count})`);
  }
  for (const sink of report.topTimeSinks) console.log(`Time sink ${sink.key}: ${sink.wallMs} ms wall, ${sink.resourceMs} ms summed`);
  const { delegates, decisionWaits, prCycle } = report;
  console.log(`Delegate spans: ${delegates.count}, merged host wall ${delegates.wallMs} ms, summed resource ${delegates.resourceMs} ms`);
  console.log(`Decision waits: ${decisionWaits.length} recorded turns`);
  for (const row of decisionWaits.slice(0, 10)) console.log(`${row.ts} ${row.turnId}: ${row.durationMs === null ? 'unknown' : `${row.durationMs / 1000} s`} (${row.decisions} observed decisions, ${row.missing} missing)`);
  console.log(prCycle ? `Merged PR cycle: ${prCycle.count} observed, median ${prCycle.medianMs ?? 'unknown'} ms, p90 ${prCycle.p90Ms ?? 'unknown'} ms, max ${prCycle.maxMs ?? 'unknown'} ms` : 'Merged PR cycle: unknown');
}
