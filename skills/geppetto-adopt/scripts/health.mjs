import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicJson, claimFile, exists, jsonFile, rejectSymlinks, userHome } from './common.mjs';
import { lockGraceMs, withLocalLock } from './local-lock.mjs';

export const hour = 60 * 60 * 1000;
export const day = 24 * hour;
export const week = 7 * day;
export const repairBackoff = [hour, 6 * hour, day];
export const recent = (timestamps = [], now) => timestamps.filter(ts => now - Date.parse(ts) < week);
export const memoryJobId = 'job:maintain-memory';
export const iso = time => new Date(time).toISOString();
export const machinePath = (home, name) => resolve(home, '.geppetto', name);

export function newCheck() {
  return { state: 'degraded', lastOk: null, lastRun: null, outcome: null, fails: 0, heals7d: [], nextAttempt: null, fingerprint: null, escalation: null, pendingNotice: null };
}
export const stalledRun = (check, now) => check?.phase === 'running' && now - Date.parse(check.lastRun) >= lockGraceMs;
export const notice = (kind, summary, now) => ({ id: randomUUID(), kind, summary, createdAt: iso(now) });

const attemptIdPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const isDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const dates = value => Array.isArray(value) && value.every(isDate);
function validCheck(check) {
  return ['ok', 'healing', 'degraded', 'blocked'].includes(check?.state) &&
    ['lastOk', 'lastRun', 'nextAttempt', 'monitoredSince', 'mechanicsCheckedAt'].every(key => check[key] == null || isDate(check[key])) &&
    [null, 'done', 'no_change', 'no_receipt', 'refused', 'error', 'reviewed', 'incomplete', 'retry', 'needs_human'].includes(check.outcome) &&
    Number.isSafeInteger(check.fails) && check.fails >= 0 && dates(check.heals7d) &&
    (check.fails7d == null || dates(check.fails7d)) &&
    (check.attemptId == null ? check.state !== 'healing' : typeof check.attemptId === 'string' && attemptIdPattern.test(check.attemptId)) &&
    (check.history == null || Object.values(check.history).every(item => dates(item?.fails) && dates(item.heals))) &&
    (check.cadenceMs == null || Number.isSafeInteger(check.cadenceMs) && check.cadenceMs > 0) &&
    (check.pendingNotice == null || ['healed', 'repair', 'blocker'].includes(check.pendingNotice.kind) &&
      typeof check.pendingNotice.id === 'string' && typeof check.pendingNotice.summary === 'string' && isDate(check.pendingNotice.createdAt));
}

export async function readHealth(home) {
  try {
    const value = JSON.parse(await readFile(machinePath(home, 'health.json'), 'utf8'));
    if (value?.v === 1 && isDate(value.writtenAt) && value.checks && typeof value.checks === 'object' && !Array.isArray(value.checks) &&
      Object.values(value.checks).every(validCheck)) return { value };
    return { problem: 'corrupt' };
  } catch (error) {
    if (error.code === 'ENOENT') return { problem: 'missing' };
    if (error instanceof SyntaxError) return { problem: 'corrupt' };
    throw error;
  }
}

/** Serialize read/modify/write across jobs and repair workers; startup only reads the snapshot. */
export async function updateHealth(home, mutate, now = Date.now()) {
  const path = machinePath(home, 'health.json');
  await rejectSymlinks(path);
  let recovered = false;
  return withLocalLock(path + '.lock', async () => {
    const { value, problem } = await readHealth(home);
    const snapshot = value ?? { v: 1, checks: {} };
    const result = await mutate(snapshot.checks, problem);
    await syncHealthLock(home, snapshot, now, recovered);
    snapshot.writtenAt = iso(Math.max(now, Date.parse(snapshot.writtenAt ?? iso(now))));
    await atomicJson(path, snapshot, { mode: 0o600 });
    return result;
  }, { wait: true, onRecovery: async healed => {
    recovered = healed;
    if (!healed) {
      const { fails7d, heals7d } = await healHistory(home, 'lock:health', now);
      await lockEvent(home, 'lock:health', 'an abandoned health lock', now, false, fails7d.length + heals7d.length + 1);
    }
  } });
}

export async function logHeal(home, row) {
  const path = machinePath(home, 'self-heal.jsonl');
  await rejectSymlinks(path);
  await mkdir(machinePath(home, '.'), { recursive: true });
  await appendFile(path, JSON.stringify(row) + '\n', { mode: 0o600 });
}

async function syncHealthLock(home, snapshot, now, recovered) {
  const journalSize = await stat(machinePath(home, 'self-heal.jsonl')).then(info => info.size, error => {
    if (error.code === 'ENOENT') return 0;
    throw error;
  });
  if (!recovered && journalSize === (snapshot.lockJournalSize ?? 0)) return;
  const id = 'lock:health', symptom = 'an abandoned health lock';
  const history = await healHistory(home, id, now);
  const previous = snapshot.checks[id] ?? newCheck();
  const lastFailure = history.fails7d.at(-1);
  if (recovered) {
    snapshot.checks[id] = { ...previous, ...history };
    await applyLockRecovery(home, snapshot.checks, id, symptom, now, true);
  } else if (lastFailure && (!previous.lastRun || Date.parse(lastFailure) > Date.parse(previous.lastRun))) {
    snapshot.checks[id] = nextLockCheck({ ...previous, ...history }, symptom, Date.parse(lastFailure), false, true);
  }
  snapshot.lockJournalSize = journalSize;
}

export async function healHistory(home, check, now, { symptom, excludeId } = {}) {
  const fails7d = [], heals7d = [];
  const journal = await readFile(machinePath(home, 'self-heal.jsonl'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  for (const line of journal.split('\n')) {
    if (!line.includes(check)) continue;
    try {
      const row = JSON.parse(line);
      if (row.check === check && (!symptom || row.symptom === symptom) && (!excludeId || row.id !== excludeId) &&
          isDate(row.ts) && Date.parse(row.ts) <= now && now - Date.parse(row.ts) < week) {
        if (row.result === 'failed') fails7d.push(row.ts);
        if (row.result === 'healed') heals7d.push(row.ts);
      }
    } catch { /* Ignore a partial record left by an interrupted write. */ }
  }
  return { fails7d, heals7d };
}

const lockEvent = (home, check, symptom, now, healed, attempt) => logHeal(home, {
  id: randomUUID(), ts: iso(now), check, symptom, action: 'reclaim lock', result: healed ? 'healed' : 'failed',
  attempt, verifiedBy: 'dead owner inspected under the recovery lock',
});

function nextLockCheck(prior, symptom, now, healed, recorded = false) {
  const heals7d = recent(prior.heals7d, now), fails7d = recent(prior.fails7d, now);
  if (!recorded) (healed ? heals7d : fails7d).push(iso(now));
  let escalation = null;
  if (fails7d.length >= repairBackoff.length) escalation = symptom + ': automatic recovery failed three times.';
  else if (heals7d.length >= repairBackoff.length) escalation = symptom + ': recurring fault, likely a code bug.';
  return { ...prior, state: escalation ? 'blocked' : healed ? 'ok' : 'degraded', lastRun: iso(now), lastOk: healed ? iso(now) : prior.lastOk,
    outcome: healed ? 'done' : 'error', heals7d, fails7d, fails: fails7d.length, fingerprint: symptom, escalation,
    nextAttempt: healed ? null : iso(now + repairBackoff[Math.min(fails7d.length, repairBackoff.length) - 1]),
    pendingNotice: escalation ? notice('blocker', escalation, now) : healed ? notice('healed', symptom + ' (reclaimed its lock)', now) : prior.pendingNotice };
}

async function applyLockRecovery(home, checks, id, symptom, now, healed) {
  const check = nextLockCheck(checks[id] ?? newCheck(), symptom, now, healed);
  await lockEvent(home, id, symptom, now, healed, check.heals7d.length + check.fails);
  checks[id] = check;
}

export function recordLockRecovery(home, id, symptom, now, healed) {
  return updateHealth(home, checks => applyLockRecovery(home, checks, id, symptom, now, healed), now);
}

async function claimNotice(home, id, now, throttle = false) {
  const directory = machinePath(home, 'notices');
  if (!throttle && !/^[a-z\d][a-z\d_-]*$/i.test(id)) return false;
  const path = resolve(directory, throttle ? createHash('sha256').update(id).digest('hex') : id);
  await rejectSymlinks(path);
  await mkdir(directory, { recursive: true });
  if (!throttle) return claimFile(path);
  let recovered = false;
  return withLocalLock(path + '.lock', async () => {
    const previous = await jsonFile(path, null);
    if (previous && now - Date.parse(previous) < day) return false;
    await atomicJson(path, iso(now), { mode: 0o600 });
    return true;
  });
}

export function maintenanceCadence(cadence = '') {
  const name = cadence.toLowerCase();
  if (name.startsWith('daily') || /^\d+ \d+ \* \* \*$/.test(name)) return day;
  if (name.startsWith('hourly') || /^\d+ \* \* \* \*$/.test(name)) return hour;
  return week;
}

export async function healthContext({ home = userHome(), now, queueRepair }) {
  const { value, problem } = await readHealth(home);
  if (!value) {
    if (problem === 'corrupt' || await exists(machinePath(home, 'machine.json'))) queueRepair(home);
    return '';
  }
  const checks = Object.entries(value.checks);
  const cadence = value.checks[memoryJobId]?.cadenceMs || week;
  const stale = now - Date.parse(value.writtenAt) > 2 * cadence;
  const overdue = ([id, check]) => id.startsWith('job:') && check.cadenceMs > 0 &&
    now - Date.parse(check.lastOk ?? check.monitoredSince) > check.cadenceMs + day;
  const waiting = check => check.nextAttempt && Date.parse(check.nextAttempt) > now;
  if (stale || checks.some(entry => {
    const [, check] = entry;
    return stalledRun(check, now) || (!waiting(check) && check.state !== 'blocked' && check.repair) || (overdue(entry) && (!check.mechanicsCheckedAt || now - Date.parse(check.mechanicsCheckedAt) > cadence));
  })) queueRepair(home);

  const oneLine = text => text.trim().replace(/\s+/g, ' ');
  // Each claim is independent. A bad marker must not discard notices already delivered by this call.
  const claim = (id, throttle) => claimNotice(home, id, now, throttle).catch(() => false);
  const lines = [];
  const blockers = checks.filter(([, check]) => check.state === 'blocked');
  if (blockers.length && await claim('blocker', true)) {
    const summaries = blockers.map(([id, check]) => check.pendingNotice?.kind === 'blocker' && typeof check.pendingNotice.summary === 'string'
      ? oneLine(check.pendingNotice.summary) : oneLine(id) + ' is blocked.');
    lines.push('Geppetto needs attention: ' + summaries.join(' '));
  }
  for (const [id, check] of checks) {
    const pending = check.pendingNotice;
    if (['healed', 'repair'].includes(pending?.kind) && typeof pending.id === 'string' && typeof pending.summary === 'string' && await claim(pending.id)) {
      lines.push(pending.kind === 'healed'
        ? 'Geppetto auto-healed ' + oneLine(pending.summary) + '. End your reply with a brief half-line note mentioning this self-heal.'
        : 'Geppetto maintenance needs attention: ' + oneLine(pending.summary));
    }
    if (check.state !== 'blocked' && overdue([id, check]) && await claim(id + ':overdue', true)) {
      lines.push('Geppetto ' + id.slice(4) + ' is overdue.');
    }
  }
  return lines.join('\n');
}
