import { createHash, randomUUID } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { cli, contained, exists, gitOutput, isMain, jsonFile, rejectSymlinks, run, userHome } from './common.mjs';
import { healHistory, iso, logHeal, machinePath, maintenanceCadence, memoryJobId, newCheck, notice, readHealth, recent, recordLockRecovery, repairBackoff, stalledRun, updateHealth } from './health.mjs';
import { withLocalLock } from './local-lock.mjs';
import { maintenanceSource, refreshMaintenanceLauncher, refreshWindowsMaintenanceLauncher } from './maintenance.mjs';
import { orphanMemoryRuns, removeOrphanMemoryRuns } from './memory-run-resources.mjs';

const signature = targets => createHash('sha256').update(JSON.stringify(targets)).digest('hex');

async function completedAttempt(home, id, attemptId) {
  if (!attemptId) return null;
  let journal;
  try { journal = await readFile(machinePath(home, 'self-heal.jsonl'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  for (const line of journal.split('\n').reverse()) {
    if (!line.includes(attemptId)) continue;
    try {
      const row = JSON.parse(line);
      if (row.id === attemptId && row.check === id && ['healed', 'failed'].includes(row.result) && Number.isFinite(Date.parse(row.ts))) return row;
    } catch { /* The interrupted line is not evidence of an outcome. */ }
  }
  return null;
}

function repairHistory(prior, now) {
  return Object.fromEntries(Object.entries(prior.history ?? {})
    .map(([key, item]) => [key, { fails: recent(item.fails, now), heals: recent(item.heals, now) }])
    .filter(([, item]) => item.fails.length || item.heals.length));
}

async function finishRepair(home, prior, fingerprint, { id, issue, action, result, ts }) {
  const now = Date.parse(ts), healed = result === 'healed';
  const history = repairHistory(prior, now), past = history[fingerprint] ?? { fails: [], heals: [] };
  (healed ? past.heals : past.fails).push(ts);
  history[fingerprint] = past;
  const exhausted = !healed && past.fails.length >= repairBackoff.length;
  const recurring = healed && past.heals.length >= repairBackoff.length;
  const escalation = recurring ? issue + ': recurring fault, likely a code bug.' : exhausted ? issue + ': automatic repair failed three times.' : null;
  const pendingNotice = escalation ? notice('blocker', escalation, now)
    : healed ? notice('healed', issue + ' (' + action + ')', now) : prior.pendingNotice?.kind === 'healed' ? prior.pendingNotice : null;
  await updateHealth(home, checks => {
    checks[id] = { ...checks[id], state: escalation ? 'blocked' : healed ? 'ok' : 'degraded', attemptId: null,
      repair: !healed && !escalation, lastOk: healed ? ts : prior.lastOk, outcome: healed ? 'done' : 'error',
      fails: past.fails.length, heals7d: past.heals, nextAttempt: healed ? null : iso(now + repairBackoff[Math.min(past.fails.length, repairBackoff.length) - 1]),
      history, escalation, pendingNotice };
  }, now);
}

async function repair(home, now, { id, issue, inspect, fix, action, verifiedBy }) {
  const prior = (await readHealth(home)).value?.checks[id] ?? newCheck();
  const completed = prior.state === 'healing' && await completedAttempt(home, id, prior.attemptId);
  if (completed) {
    await finishRepair(home, prior, prior.fingerprint, { id, issue, action, result: completed.result, ts: completed.ts });
    return;
  }
  let targets;
  try { targets = await inspect(); } catch { targets = null; }
  if (targets?.length === 0) {
    if (prior.state !== 'blocked') await updateHealth(home, checks => {
      checks[id] = { ...prior, state: 'ok', lastRun: iso(now), lastOk: iso(now), outcome: 'no_change', attemptId: null, nextAttempt: null, repair: false };
    }, now);
    return;
  }
  const fingerprint = signature(targets), history = repairHistory(prior, now);
  const sameFault = prior.fingerprint === fingerprint;
  if (sameFault && (prior.state === 'blocked' || Date.parse(prior.nextAttempt) > now)) return;
  const past = history[fingerprint] ?? { fails: [], heals: [] };
  const attempt = past.fails.length + past.heals.length + 1, attemptId = randomUUID();
  await updateHealth(home, checks => {
    checks[id] = { ...prior, state: 'healing', repair: true, lastRun: iso(now), fingerprint, attemptId };
  }, now);
  let healed = false;
  try {
    if (targets) {
      await fix(targets);
      healed = (await inspect()).length === 0;
    }
  } catch { /* The failed attempt remains visible in health and in the repair journal. */ }
  const result = healed ? 'healed' : 'failed', ts = iso(now);
  await logHeal(home, { id: attemptId, ts, check: id, symptom: issue, action, result, attempt, verifiedBy });
  await finishRepair(home, prior, fingerprint, { id, issue, action, result, ts });
}

async function missingLaunchers(home, windows) {
  const paths = ['bin/maintenance-launcher.mjs', ...(windows ? ['maintenance.vbs'] : [])];
  const missing = [];
  for (const name of paths) {
    const path = machinePath(home, name);
    await rejectSymlinks(path);
    if (!await exists(path)) missing.push(name);
    else if (!(await lstat(path)).isFile()) throw new Error('Unexpected maintenance launcher type.');
  }
  return missing;
}

async function fixLaunchers(home, machine, targets) {
  const sources = [...new Set(Object.values(machine.projects ?? {}).flatMap(Object.values))];
  const source = machine.maintenanceSource ?? (sources.length === 1 ? sources[0] : null);
  if (typeof source !== 'string' || !isAbsolute(source)) throw new Error('Maintenance package source is ambiguous.');
  const active = await maintenanceSource(source);
  await readFile(resolve(active, 'skills/geppetto-adopt/scripts/maintenance.mjs'));
  await readFile(resolve(active, 'skills/geppetto-adopt/scripts/common.mjs'));
  if (targets.includes('bin/maintenance-launcher.mjs') && !await exists(machinePath(home, 'bin/maintenance-launcher.mjs'))) {
    await refreshMaintenanceLauncher(home, { path: source }, { missingOnly: true });
  }
  if (targets.includes('maintenance.vbs') && !await exists(machinePath(home, 'maintenance.vbs'))) {
    await refreshWindowsMaintenanceLauncher(home, machinePath(home, 'bin/maintenance-launcher.mjs'), { missingOnly: true });
  }
}

async function orphanWorktrees(home, machine) {
  const owned = machinePath(home, 'worktrees');
  if (!await exists(owned)) return [];
  await rejectSymlinks(owned);
  const candidates = [];
  for (const repo of Object.keys(machine.projects ?? {}).sort()) {
    if (!await exists(repo) || resolve(repo) === resolve(machine.memory?.localPath ?? home)) continue;
    const listing = gitOutput(repo, ['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain'], { trim: false, detail: false });
    for (const record of listing.split(/\r?\n\r?\n/)) {
      const [entry, ...fields] = record.split(/\r?\n/);
      if (!entry.startsWith('worktree ') || !fields.some(field => field.startsWith('prunable '))) continue;
      const reported = entry.slice('worktree '.length);
      if (!isAbsolute(reported)) continue;
      const path = resolve(reported);
      if (path !== owned && contained(owned, path) && !await exists(path)) {
        await rejectSymlinks(path);
        candidates.push({ repo, path });
      }
    }
  }
  return candidates;
}

const healthStoreId = 'health:store';
const corruptSnapshot = 'corrupt health snapshot';

async function priorHealthRebuilds(home, now, excludeId) {
  const { fails7d, heals7d } = await healHistory(home, healthStoreId, now, { symptom: corruptSnapshot, excludeId });
  return { corrupt: { fails: fails7d, heals: heals7d } };
}

async function finishHealthRebuild(home, now, check) {
  if (check?.state !== 'healing' || !check.attemptId) return;
  let row = await completedAttempt(home, healthStoreId, check.attemptId);
  const history = check.history ?? await priorHealthRebuilds(home, row ? Date.parse(row.ts) : now, check.attemptId);
  if (!row) {
    if (!(await readHealth(home)).value) return;
    row = { id: check.attemptId, ts: iso(now), check: healthStoreId, symptom: corruptSnapshot,
      action: 'rebuild health snapshot', result: 'healed', attempt: history.corrupt.heals.length + 1, verifiedBy: 'versioned snapshot parsed from disk' };
    await logHeal(home, row);
  }
  await finishRepair(home, { ...check, history }, 'corrupt', { id: healthStoreId, issue: 'the local health snapshot',
    action: 'rebuilt and verified', result: row.result, ts: row.ts });
}

async function rebuildHealth(home, now, problem) {
  const attemptId = randomUUID(), ts = iso(now);
  const history = problem === 'corrupt' ? await priorHealthRebuilds(home, now) : null;
  const row = { id: attemptId, ts, check: healthStoreId, symptom: problem + ' health snapshot',
    action: 'rebuild health snapshot', attempt: (history?.corrupt.heals.length ?? 0) + 1, verifiedBy: 'versioned snapshot parsed from disk' };
  const check = history ? { ...newCheck(), state: 'healing', lastRun: ts, attemptId, repair: true, fingerprint: 'corrupt', history } : null;
  try {
    await updateHealth(home, checks => { if (check) checks[healthStoreId] = check; }, now);
    if (!(await readHealth(home)).value) throw new Error('Health snapshot could not be verified.');
  } catch (error) {
    await logHeal(home, { ...row, result: 'failed' });
    throw error;
  }
  await logHeal(home, { ...row, result: 'healed' });
  await finishHealthRebuild(home, now, check);
}

async function finishInterruptedRun(home, now, check) {
  if (!stalledRun(check, now)) return;
  const lock = machinePath(home, 'maintain-memory.lock');
  await withLocalLock(lock, () => updateHealth(home, checks => {
    const current = checks[memoryJobId];
    if (current?.runId !== check.runId || !stalledRun(current, now)) return;
    const summary = 'maintain-memory stopped before its runner verified a receipt.';
    checks[memoryJobId] = { ...current, phase: null, state: 'degraded', outcome: 'error', fails: current.fails + 1,
      fingerprint: 'interrupted', escalation: null, pendingNotice: notice('repair', summary, now) };
  }, now), { now: () => now, onRecovery: healed => recordLockRecovery(home, 'lock:maintenance', 'an abandoned maintenance lock', now, healed) });
}

/** Inspect and repair owned mechanical faults once; a concurrent worker skips. */
export async function heal({ home = userHome(), now = Date.now() } = {}) {
  const directory = machinePath(home, '.');
  const machineFile = machinePath(home, 'machine.json');
  if (!await exists(machineFile) && !await exists(machinePath(home, 'health.json'))) return;
  await rejectSymlinks(directory);
  const lock = machinePath(home, 'heal.lock');
  return withLocalLock(lock, async () => {
    const machine = await jsonFile(machineFile, {});
    const { value, problem } = await readHealth(home);
    if (!value) await rebuildHealth(home, now, problem);
    else await finishHealthRebuild(home, now, value.checks[healthStoreId]);
    await finishInterruptedRun(home, now, value?.checks[memoryJobId]);
    const scheduled = Object.values(machine.jobs ?? {}).filter(job => job.status === 'scheduled');
    const windows = scheduled.some(job => job.scheduler === 'windows-task-scheduler');
    if (windows || scheduled.some(job => job.scheduler === 'cron')) await repair(home, now, {
      id: 'launcher:maintenance', issue: 'the maintenance launcher', inspect: () => missingLaunchers(home, windows),
      fix: targets => fixLaunchers(home, machine, targets), action: 'regenerated missing launcher files', verifiedBy: 'all scheduled launcher files present',
    });
    await repair(home, now, {
      id: 'worktrees:orphans', issue: 'orphan worktree registrations', inspect: () => orphanWorktrees(home, machine),
      fix: async targets => {
        for (const { repo, path } of targets) {
          await rejectSymlinks(path);
          if (!await exists(path)) gitOutput(repo, ['worktree', 'remove', '--', path], { execute: run, detail: false });
        }
      }, action: 'pruned missing worktree registrations', verifiedBy: 'Git lists no remaining managed orphan',
    });
    await repair(home, now, {
      id: 'worktrees:memory-runs', issue: 'abandoned memory maintenance resources', inspect: () => orphanMemoryRuns(home),
      fix: names => removeOrphanMemoryRuns(home, names), action: 'removed isolated profiles and worktree registrations',
      verifiedBy: 'no registered memory run remains for a dead owner',
    });
    await updateHealth(home, checks => {
      const job = machine.jobs?.['maintain-memory'];
      if (job?.status === 'scheduled') {
        const cadenceMs = maintenanceCadence(job.cadence), nextRun = Date.parse(job.nextRun);
        const check = checks[memoryJobId] ?? newCheck();
        const monitoredSince = Number.isFinite(nextRun) ? Math.min(now, nextRun - cadenceMs) : now;
        checks[memoryJobId] = { ...check, cadenceMs, monitoredSince: check.monitoredSince ?? iso(monitoredSince), mechanicsCheckedAt: iso(now) };
      } else if (machine.jobs) delete checks[memoryJobId];
    }, now);
  }, { now: () => now, onRecovery: healed => recordLockRecovery(home, 'lock:heal', 'an abandoned repair lock', now, healed) });
}

if (isMain(import.meta.url)) await cli(() => heal());
