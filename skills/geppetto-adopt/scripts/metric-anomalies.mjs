import { createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendRecord, atomicJson, claimFile, jsonFile, recordContext, run, UsageError } from './common.mjs';
import { projectRecords } from './project-records.mjs';
import { recordSignal, redactValue } from './signal.mjs';
import { commandArgs, commandSegments, toolCommand } from './turn-checks.mjs';
import { readTurnState } from './turn-messages.mjs';

const minSamples = 5;
const minMeasuredMs = 10_000;
const coldCommandMs = 60_000;
const coldDelegateMs = 600_000;
const medianMultiplier = 2;
const p90Multiplier = 1.25;
const signalPath = fileURLToPath(new URL('./signal.mjs', import.meta.url)).replaceAll('\\', '/');
const digest = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const stateFile = (root, name) => resolve(root, '.geppetto/hook-state', name);
const noteFile = (root, kind, session, turn, key) => stateFile(root, `metric-${kind}-${digest([session, turn, key])}.json`);
const positive = value => Number.isSafeInteger(value) && value > 0;
const validKey = value => typeof value === 'string' && /^[\w.:@-]+(?: [\w.:@-]+)*$/.test(value);

export function timedMetric(row) {
  return ['command', 'suite', 'delegate'].includes(row.kind) && Number.isFinite(row.durationMs) && row.durationMs >= 0;
}

export function metricBaselines(rows) {
  return Object.fromEntries([...Map.groupBy(rows.filter(timedMetric), row => row.key)].map(([key, group]) => {
    const times = group.map(row => row.durationMs).sort((a, b) => a - b);
    const n = times.length;
    return [key, { n, p50: (times[Math.floor((n - 1) / 2)] + times[Math.floor(n / 2)]) / 2, p90: times[Math.ceil(n * 0.9) - 1] }];
  }));
}

export function metricAnomaly(row, baseline, { expectedMs, warnMs } = {}) {
  if (positive(expectedMs)) return row.durationMs > expectedMs ? { thresholdMs: expectedMs, rule: 'expectation' } : null;
  if (positive(warnMs)) return row.durationMs > warnMs ? { thresholdMs: warnMs, rule: 'approved threshold' } : null;
  if (baseline?.n >= minSamples) {
    const thresholdMs = Math.max(medianMultiplier * baseline.p50, p90Multiplier * baseline.p90);
    return row.durationMs >= minMeasuredMs && row.durationMs > thresholdMs ? { thresholdMs, rule: 'observed baseline' } : null;
  }
  const thresholdMs = row.kind === 'delegate' ? coldDelegateMs : coldCommandMs;
  return row.durationMs >= thresholdMs ? { thresholdMs, rule: 'cold-start floor' } : null;
}

export async function metricLimits(root, { sessionId, turnId, key }, config) {
  const expectation = turnId ? await jsonFile(noteFile(root, 'expectation', sessionId, turnId, key), {}) : {};
  const warnMs = Object.hasOwn(config?.thresholds ?? {}, key) ? config.thresholds[key]?.warnMs : undefined;
  return { expectedMs: positive(expectation.expectedMs) ? expectation.expectedMs : undefined, warnMs: positive(warnMs) ? warnMs : undefined };
}

export async function metricReminder(root, row) {
  const { sessionId, turnId, key } = row;
  if (!sessionId || !turnId || !validKey(key) || (!row.limits && row.durationMs < minMeasuredMs)) return '';
  let baseline;
  if (!row.limits) {
    const rows = await projectRecords(root, 'metrics');
    const current = rows.findIndex(value => value.metricId === row.metricId);
    const baselines = metricBaselines((current < 0 ? rows : rows.slice(0, current)).filter(value => value.key === key));
    baseline = Object.hasOwn(baselines, key) ? baselines[key] : undefined;
  }
  const anomaly = metricAnomaly(row, baseline, row.limits);
  if (!anomaly) return '';
  const marker = noteFile(root, 'reminder', sessionId, turnId, key);
  if (!await claimFile(marker)) return '';
  try {
    await appendRecord(root, 'metrics', redactValue({ kind: 'reminder', key, sessionId, turnId, ts: row.ts, durationMs: row.durationMs, ...anomaly }));
  } catch (error) { await unlink(marker); throw error; }
  const diagnosis = JSON.stringify({ kind: 'diagnosis', key, verdict: 'expected', reason: '<specific reason>' });
  return `Geppetto timing: ${key} took ${row.durationMs} ms (${anomaly.rule}: ${anomaly.thresholdMs} ms). Record a diagnosis with node "${signalPath}" --metric '${diagnosis}' --session "${sessionId}" --turn "${turnId}" and select expected, investigate, or threshold.`;
}

export async function prTimingNote(root, event, row, execute = run) {
  if (!row.ok) return '';
  const command = commandSegments(toolCommand(event)).map(segment => commandArgs(segment)).find(({ executable, positional, flags }) =>
    executable === 'gh' && positional[0] === 'pr' && ['create', 'merge'].includes(positional[1]) && !flags.has('--help') && !flags.has('-h'));
  if (!command) return '';
  const response = typeof event.tool_response === 'string' ? event.tool_response : event.tool_response?.output ?? '';
  const pullUrl = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/i;
  const explicit = command.positional[2] ?? '';
  const target = response.match(pullUrl)?.[0] ?? (pullUrl.test(explicit) || /^\d+$/.test(explicit) ? explicit : undefined);
  const repo = command.flags.get('--repo') ?? command.flags.get('-R');
  const cwd = resolve(root, event.tool_input?.workdir ?? event.tool_input?.cwd ?? '.');
  const view = execute('gh', ['pr', 'view', ...(target ? [target] : []), ...(repo ? ['--repo', repo] : []),
    '--json', 'number,createdAt,mergedAt,baseRefName,state'], { cwd, timeout: 3000 });
  if (view.status !== 0) return 'Geppetto PR timing: elapsed time, review rounds and anomalous operations unavailable.';
  const pr = JSON.parse(view.stdout);
  if (command.positional[1] === 'merge' && pr.state !== 'MERGED') return '';
  const created = Date.parse(pr.createdAt);
  const startCommit = !repo && !pullUrl.test(explicit) && pr.baseRefName && execute('git', ['log', '--reverse', '--format=%cI', `origin/${pr.baseRefName}..HEAD`], { cwd, timeout: 1500 });
  const firstCommit = startCommit?.status === 0 ? Date.parse(startCommit.stdout.split(/\r?\n/)[0]) : NaN;
  const start = Number.isFinite(firstCommit) && firstCommit <= created ? firstCommit : created;
  const end = Date.parse(pr.mergedAt ?? row.ts);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return `Geppetto PR #${pr.number} timing: elapsed time, review rounds and anomalous operations unavailable.`;
  const [reviews, metrics] = await Promise.all([
    projectRecords(root, 'reviews', { currentWorktree: true }),
    projectRecords(root, 'metrics', { currentWorktree: true }),
  ]);
  const inWindow = item => Date.parse(item.ts) >= start && Date.parse(item.ts) <= end;
  const anomalies = metrics.filter(item => item.kind === 'reminder' && inWindow(item));
  const rounds = reviews.filter(inWindow).length;
  return `Geppetto PR #${pr.number}: ${end - start} ms elapsed (${start === firstCommit ? 'branch' : 'PR'}), ${rounds} recorded review rounds and ${anomalies.length} timing reminders in this worktree window${anomalies.length ? ` (${[...new Set(anomalies.map(item => item.key))].join(', ')})` : ''}.`;
}

export async function recordMetricNote(root, note, { session, turn }) {
  const { kind, key, expectedMs, verdict, reason, warnMs } = note ?? {};
  if (!session || !validKey(key)) throw new UsageError('Metric notes need a session and operation key.');
  const state = await readTurnState(root, session, turn);
  if (!state?.turn || (turn && turn !== state.turn)) throw new UsageError('Metric notes need the active project turn.');
  turn = state.turn;
  const identity = { harness: state.harness ?? null, sessionId: session, turnId: turn, epoch: state.epoch };
  const entry = { ...identity, key, kind, ts: new Date().toISOString() };
  if (kind === 'expectation' && positive(expectedMs)) {
    const expectation = { ...entry, expectedMs };
    await appendRecord(root, 'metrics', expectation);
    await atomicJson(noteFile(root, kind, session, turn, key), expectation);
    return expectation;
  }
  const { placeholderReason } = await import('./gate-sections.mjs');
  if (kind !== 'diagnosis' || !['expected', 'investigate', 'threshold'].includes(verdict) || typeof reason !== 'string' ||
      /[\r\n]/.test(reason) || placeholderReason(reason) || reason === '<specific reason>' || (verdict === 'threshold' && !positive(warnMs))) {
    throw new UsageError('Record expected, investigate or threshold with a specific one-line reason. Threshold proposals also need warnMs.');
  }
  const reminder = (await projectRecords(root, 'metrics')).findLast(row => row.kind === 'reminder' && row.sessionId === session && row.turnId === turn && row.key === key);
  if (!reminder) throw new UsageError('No matching reminder in this turn.');
  const marker = noteFile(root, 'diagnosis', session, turn, key);
  const diagnosis = redactValue({ ...entry, verdict, reason, ...(verdict === 'threshold' && { warnMs }) });
  if (!await claimFile(marker)) return { ...diagnosis, duplicate: true };
  try {
    if (verdict === 'investigate') {
      const signalKey = 'metric-' + digest([key]).slice(0, 12);
      await recordContext.run(identity, () => recordSignal(root, { key: signalKey, text: `${key}: ${reason}`,
        session, turn, category: 'efficiency', source: 'agent', evidence: `Timing reminder at ${reminder.ts}` }));
    }
    await appendRecord(root, 'metrics', diagnosis);
  } catch (error) { await unlink(marker); throw error; }
  return diagnosis;
}
