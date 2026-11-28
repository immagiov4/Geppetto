import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, renameSync, symlinkSync, unlinkSync, utimesSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { delimiter, resolve } from 'node:path';
import { fixture, get, put, invoke, git, repo, restoreEnv } from './helpers.mjs';
import { handleEvent } from '../skills/geppetto-adopt/scripts/hook.mjs';
import { withTurnLock } from '../skills/geppetto-adopt/scripts/turn-messages.mjs';
import { newCheck } from '../skills/geppetto-adopt/scripts/health.mjs';

const hour = 60 * 60 * 1000;
const day = 24 * hour;
const week = 7 * day;
const now = Date.parse('2026-11-28T08:00:00Z');
const iso = ms => new Date(ms).toISOString();
const healthPath = '.geppetto/health.json';
const jobId = 'job:maintain-memory';
const health = home => JSON.parse(get(home, healthPath));
const writeHealth = (home, checks) => put(home, healthPath, { v: 1, writtenAt: iso(now), checks: Object.fromEntries(Object.entries(checks).map(([id, check]) => [id, { ...newCheck(), ...check }])) });
const healthy = { state: 'ok', lastOk: iso(now), lastRun: iso(now), outcome: 'no_change', cadenceMs: week };
function start(home, options = {}) {
  const config = '.geppetto/config.json';
  if (!existsSync(resolve(home, config))) put(home, config, { memory: { choice: 'none' } });
  return handleEvent({ cwd: home, hook_event_name: 'SessionStart' }, { home, now: () => now, queueHealthRepair: () => {}, ...options });
}
const context = response => response.hookSpecificOutput?.additionalContext ?? '';

function memoryJob(t, body) {
  const home = fixture(t), memory = fixture(t);
  assert.equal(git(memory, ['init']).status, 0);
  put(memory, 'index.md', '# Memory\n\n- [Sample](buckets/sample/index.md)');
  put(memory, 'buckets/sample/index.md', '# Fixture');
  assert.equal(git(memory, ['add', '.']).status, 0);
  assert.equal(commit(memory), 0);
  put(home, '.geppetto/machine.json', { memory: { localPath: memory }, jobs: { 'maintain-memory': { status: 'scheduled', host: 'codex' } } });
  put(home, 'node_modules/@openai/codex/bin/codex.js', "const fs=require('node:fs'); let prompt=''; process.stdin.on('data',d=>prompt+=d); process.stdin.on('end',()=>{" + body + "});");
  return { home, memory, run: () => invoke('maintenance.mjs', ['--run', 'maintain-memory'], { cwd: home, home, env: { PATH: home + delimiter + process.env.PATH } }) };
}
const commit = memory => git(memory, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-am', 'Fixture input']).status;

test('exit zero without a valid proposal records incomplete health and fails the job', t => {
  const { home, run } = memoryJob(t, "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:5,output_tokens:2}}));");
  const result = run();
  assert.equal(result.status, 1, result.stderr);
  assert.equal(health(home).checks[jobId].state, 'degraded');
  assert.equal(health(home).checks[jobId].outcome, 'incomplete');
  assert.equal(health(home).checks[jobId].lastOk, null);
});

test('turn lock reclaims a dead owner past the grace period and records a verified recovery', async t => {
  const home = fixture(t);
  const lock = resolve(home, 'turn.lock');
  put(home, 'turn.lock', '2147483647');
  utimesSync(lock, new Date(now - hour), new Date(now - hour));
  assert.equal(await withTurnLock(lock, async () => 'entered', { home, now: () => now }), 'entered');
  assert.equal(existsSync(lock), false);
  const row = JSON.parse(get(home, '.geppetto/self-heal.jsonl'));
  assert.equal(row.result, 'healed');
  assert.equal(row.check, 'lock:turn');
  assert.ok(row.verifiedBy);
});

test('SessionStart contributes zero bytes with fresh, successful health and honours the overdue grace period', async t => {
  const home = fixture(t);
  writeHealth(home, { [jobId]: healthy });
  assert.deepEqual(await start(home), {});
  writeHealth(home, { [jobId]: { ...healthy, lastOk: iso(now - week - day) } });
  assert.deepEqual(await start(home), {});
  writeHealth(home, { [jobId]: { ...healthy, lastOk: iso(now - week - day - 1) } });
  assert.match(context(await start(home)), /overdue/i);
});

test('concurrent SessionStarts claim one healed notice and give it to the reply', async t => {
  const home = fixture(t);
  writeHealth(home, { [jobId]: { ...healthy, pendingNotice: { id: 'repair-one', kind: 'healed', summary: 'maintenance launcher', createdAt: iso(now) } } });
  const results = (await Promise.all(Array.from({ length: 8 }, () => start(home)))).map(context).filter(Boolean);
  assert.equal(results.length, 1);
  assert.match(results[0], /auto-healed maintenance launcher.*end your reply/i);
});

test('blocker notice has a sliding 24-hour throttle across SessionStarts', async t => {
  const home = fixture(t);
  writeHealth(home, { [jobId]: { ...healthy, state: 'blocked', pendingNotice: { id: 'block-a', kind: 'blocker', summary: 'repair permissions', createdAt: iso(now) } } });
  assert.match(context(await start(home)), /repair permissions/);
  assert.equal(context(await start(home, { now: () => now + day - 1 })), '');
  assert.match(context(await start(home, { now: () => now + day })), /repair permissions/);
});

test('corrupt health queues a rebuild and a dashboard fault fails open', async t => {
  const home = fixture(t);
  put(home, healthPath, 'broken');
  let queued = 0;
  assert.deepEqual(await start(home, { queueHealthRepair: () => { queued++; throw Error('fixture spawn error'); } }), {});
  assert.equal(queued, 1);
});

test('launcher repair retries on schedule and blocks on the third failed verification', async t => {
  const { heal } = await import('../skills/geppetto-adopt/scripts/heal.mjs');
  const home = fixture(t);
  put(home, '.geppetto/machine.json', { maintenanceSource: resolve(home, 'missing-source'), jobs: { 'maintain-memory': { status: 'scheduled', scheduler: 'cron' } } });
  await heal({ home, now });
  const check = () => health(home).checks['launcher:maintenance'];
  assert.equal(check().state, 'degraded');
  assert.equal(check().nextAttempt, iso(now + hour));
  await heal({ home, now: now + hour - 1 });
  assert.equal(check().fails, 1);
  await heal({ home, now: now + hour });
  assert.equal(check().nextAttempt, iso(now + 7 * hour));
  await heal({ home, now: now + 7 * hour });
  assert.equal(check().state, 'blocked');
  assert.equal(check().fails, 3);
  assert.equal(check().nextAttempt, iso(now + 31 * hour));
  const records = get(home, '.geppetto/self-heal.jsonl').trim().split(/\r?\n/).map(JSON.parse).filter(row => row.check === 'launcher:maintenance');
  assert.deepEqual(records.map(row => row.result), ['failed', 'failed', 'failed']);
});

test('three verified launcher regenerations in seven days flag a recurring fault', async t => {
  const { heal } = await import('../skills/geppetto-adopt/scripts/heal.mjs');
  const home = fixture(t), launcher = '.geppetto/bin/maintenance-launcher.mjs';
  put(home, '.geppetto/machine.json', { maintenanceSource: repo, jobs: { 'maintain-memory': { status: 'scheduled', scheduler: 'cron' } } });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) unlinkSync(resolve(home, launcher));
    await heal({ home, now: now + attempt * day });
    assert.match(get(home, launcher), /maintenance\.mjs/);
  }
  const check = health(home).checks['launcher:maintenance'];
  assert.equal(check.state, 'blocked');
  assert.deepEqual(check.heals7d, [iso(now), iso(now + day), iso(now + 2 * day)]);
  assert.match(check.escalation, /recurring fault/i);
  assert.match(context(await start(home, { now: () => now + 2 * day })), /recurring fault/i);
});

test('nonzero subscription process with verified missing authentication records a hard blocker', t => {
  const { home, run } = memoryJob(t, "if (process.argv.includes('login')) console.error('Not logged in'); process.exitCode=1;");
  assert.equal(run().status, 1);
  const check = health(home).checks[jobId];
  assert.equal(check.state, 'blocked');
  assert.match(check.escalation, /sign in/i);
});

test('detached startup repairs corrupt health in the selected home and owns a single worker lock', async t => {
  const { heal } = await import('../skills/geppetto-adopt/scripts/heal.mjs');
  const home = fixture(t);
  put(home, healthPath, '{invalid');
  put(home, '.geppetto/heal.lock', String(process.pid));
  await heal({ home, now });
  assert.equal(get(home, healthPath), '{invalid');
  unlinkSync(resolve(home, '.geppetto/heal.lock'));
  const ambientHome = fixture(t), saved = { ...process.env };
  put(home, '.geppetto/config.json', { memory: { choice: 'none' } });
  put(ambientHome, healthPath, 'ambient profile');
  process.env.HOME = ambientHome;
  process.env.USERPROFILE = ambientHome;
  try {
    assert.deepEqual(await handleEvent({ cwd: home, hook_event_name: 'SessionStart' }, { home }), {});
  } finally { restoreEnv(saved); }
  await waitFor(() => {
    try { return health(home).checks['health:store']?.state === 'ok' && !existsSync(resolve(home, '.geppetto/heal.lock')); }
    catch (error) { if (error instanceof SyntaxError) return false; throw error; }
  });
  assert.match(context(await start(home)), /auto-healed the local health snapshot/i);
  assert.equal(get(ambientHome, healthPath), 'ambient profile');
});

test('the repair removes only missing registrations under the managed worktree directory', async t => {
  const { heal } = await import('../skills/geppetto-adopt/scripts/heal.mjs');
  const home = fixture(t), project = fixture(t), outside = fixture(t);
  assert.equal(git(project, ['init']).status, 0);
  put(project, 'file.md', 'tracked');
  assert.equal(git(project, ['add', '.']).status, 0);
  assert.equal(commit(project), 0);
  const owned = resolve(home, '.geppetto/worktrees');
  const locations = [resolve(owned, 'gone'), resolve(owned, 'dirty'), resolve(outside, 'foreign')];
  for (const path of locations) assert.equal(git(project, ['worktree', 'add', '--detach', path]).status, 0);
  renameSync(locations[0], resolve(outside, 'old-owned'));
  renameSync(locations[2], resolve(outside, 'old-foreign'));
  put(locations[1], 'file.md', 'dirty');
  put(home, '.geppetto/machine.json', { projects: { [project]: {} }, jobs: {} });
  await heal({ home, now });
  const listing = git(project, ['worktree', 'list', '--porcelain']).stdout;
  assert.ok(!listing.includes('/gone\n'));
  assert.ok(listing.includes('/dirty\n'));
  assert.ok(listing.includes('/foreign\n'));
  assert.equal(get(locations[1], 'file.md'), 'dirty');
  assert.equal(health(home).checks['worktrees:orphans'].outcome, 'done');
});

test('a claimed repair notice does not suppress the later overdue warning', async t => {
  const home = fixture(t);
  writeHealth(home, { [jobId]: { ...healthy, state: 'degraded', pendingNotice: { id: 'claimed-repair', kind: 'repair', summary: 'missing receipt', createdAt: iso(now) } } });
  assert.match(context(await start(home)), /missing receipt/);
  assert.match(context(await start(home, { now: () => now + week + day + 1 })), /overdue/);
  const lateHome = fixture(t);
  writeHealth(lateHome, health(home).checks);
  const both = context(await start(lateHome, { now: () => now + week + day + 1 }));
  assert.match(both, /missing receipt/);
  assert.match(both, /overdue/);
});

test('a parseable snapshot with an invalid check timestamp queues a rebuild', async t => {
  const home = fixture(t);
  let queued = 0;
  const invalid = [{ ...healthy, lastOk: 'broken' }, ...[{ toString: null }, '', 'malformed'].map(attemptId => ({ state: 'healing', attemptId }))];
  for (const check of invalid) {
    writeHealth(home, { [jobId]: check });
    assert.deepEqual(await start(home, { queueHealthRepair: () => queued++ }), {});
  }
  assert.equal(queued, invalid.length);
});

test('a journaled heal replays the result after interruption without duplicating the attempt', async t => {
  const { heal } = await import('../skills/geppetto-adopt/scripts/heal.mjs');
  const home = fixture(t);
  put(home, '.geppetto/machine.json', { maintenanceSource: repo, jobs: { 'maintain-memory': { status: 'scheduled', scheduler: 'cron' } } });
  await heal({ home, now });
  const journal = get(home, '.geppetto/self-heal.jsonl');
  const row = journal.trim().split(/\r?\n/).map(JSON.parse).find(item => item.check === 'launcher:maintenance');
  const fingerprint = health(home).checks[row.check].fingerprint;
  writeHealth(home, { [row.check]: { state: 'healing', attemptId: row.id, fingerprint, repair: true } });
  await heal({ home, now: now + 1 });
  const check = health(home).checks[row.check];
  assert.equal(check.outcome, 'done');
  assert.deepEqual(check.heals7d, [row.ts]);
  assert.equal(check.pendingNotice.kind, 'healed');
  assert.equal(get(home, '.geppetto/self-heal.jsonl'), journal);
});

test('old repair-worker locks escalate on the third verified reclamation', async t => {
  const { heal } = await import('../skills/geppetto-adopt/scripts/heal.mjs');
  const home = fixture(t);
  put(home, '.geppetto/machine.json', { jobs: {} });
  const relativeLock = '.geppetto/heal.lock';
  for (let attempt = 0; attempt < 3; attempt++) {
    put(home, relativeLock, '2147483647');
    utimesSync(resolve(home, relativeLock), new Date(now - hour), new Date(now - hour));
    await heal({ home, now: now + attempt * hour });
  }
  const check = health(home).checks['lock:heal'];
  assert.equal(check.state, 'blocked');
  assert.equal(check.heals7d.length, 3);
  const rows = get(home, '.geppetto/self-heal.jsonl').trim().split(/\r?\n/).map(JSON.parse).filter(row => row.check === 'lock:heal');
  assert.deepEqual(rows.map(row => row.attempt), [1, 2, 3]);
});

test('memory dry-run resolves the same checkout without inspecting unrelated plugin caches', t => {
  const { home, memory } = memoryJob(t, '');
  const path = '.geppetto/machine.json', machine = JSON.parse(get(home, path));
  machine.projects = { [fixture(t)]: { codex: resolve(home, 'absent-package-cache/0.1.0') } };
  put(home, path, machine);
  const result = invoke('maintenance.mjs', ['--run', 'maintain-memory', '--dry-run'], { cwd: home, home });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).roots, [memory]);
  assert.equal(existsSync(resolve(home, healthPath)), false);
});

test('a journaled health-store rebuild restores its notice after interruption', async t => {
  const { heal } = await import('../skills/geppetto-adopt/scripts/heal.mjs');
  const home = fixture(t);
  put(home, healthPath, 'invalid');
  await heal({ home, now });
  const journal = get(home, '.geppetto/self-heal.jsonl');
  const row = journal.trim().split(/\r?\n/).map(JSON.parse).find(item => item.check === 'health:store');
  writeHealth(home, { [row.check]: { state: 'healing', attemptId: row.id, fingerprint: 'corrupt', repair: true } });
  await heal({ home, now: now + 1 });
  assert.equal(health(home).checks[row.check].pendingNotice.kind, 'healed');
  assert.equal(get(home, '.geppetto/self-heal.jsonl'), journal);
});

test('ordinary health publication restores lock failures after the lock is cleared externally', async t => {
  const { logHeal, updateHealth } = await import('../skills/geppetto-adopt/scripts/health.mjs');
  const home = fixture(t);
  writeHealth(home, {});
  for (let attempt = 1; attempt <= 3; attempt++) await logHeal(home, {
    id: 'fixture-' + attempt, ts: iso(now - attempt * hour), check: 'lock:health', symptom: 'an abandoned health lock',
    action: 'reclaim lock', result: 'failed', attempt, verifiedBy: 'verified dead owner',
  });
  await updateHealth(home, () => {}, now);
  const check = health(home).checks['lock:health'];
  assert.equal(check.fails, 3);
  assert.equal(check.state, 'blocked');
});

test('SessionStart keeps a claimed notice when a later notice cannot be claimed', async t => {
  const home = fixture(t), outside = fixture(t);
  put(outside, 'proof', 'outside');
  writeHealth(home, {
    first: { ...healthy, pendingNotice: { id: 'first', kind: 'healed', summary: 'first recovery', createdAt: iso(now) } },
    second: { ...healthy, pendingNotice: { id: 'second', kind: 'healed', summary: 'second recovery', createdAt: iso(now) } },
  });
  mkdirSync(resolve(home, '.geppetto/notices'));
  symlinkSync(outside, resolve(home, '.geppetto/notices/second'), 'junction');
  const first = context(await start(home));
  assert.match(first, /first recovery/);
  assert.doesNotMatch(first, /second recovery/);
  assert.equal(context(await start(home)), '');
  assert.equal(get(outside, 'proof'), 'outside');
});

test('repair reclaims only registered memory run resources owned by a dead PID', async t => {
  const { heal } = await import('../skills/geppetto-adopt/scripts/heal.mjs');
  const home = fixture(t), memory = fixture(t);
  assert.equal(git(memory, ['init']).status, 0);
  put(memory, 'file.md', 'tracked');
  assert.equal(git(memory, ['add', '.']).status, 0);
  assert.equal(commit(memory), 0);
  put(home, '.geppetto/config.json', { memory: { localPath: memory } });
  writeHealth(home, {});
  const makeRun = (id, pid) => {
    const dir = '.geppetto/worktrees/memory-run-00000000-0000-4000-8000-00000000000' + id;
    if (pid) put(home, dir + '/owner.json', { pid, repo: memory });
    put(home, dir + '/runner/codex-fixture/profile/auth.json', { fixture: true });
    assert.equal(git(memory, ['worktree', 'add', '--detach', resolve(home, dir, 'checkout')]).status, 0);
    return dir;
  };
  const crashed = makeRun('1', 2147483647), live = makeRun('2', process.pid), unowned = makeRun('3');
  await heal({ home, now });
  assert.equal(existsSync(resolve(home, crashed)), false);
  assert.equal(existsSync(resolve(home, live, 'runner/codex-fixture/profile/auth.json')), true);
  assert.equal(existsSync(resolve(home, unowned, 'runner/codex-fixture/profile/auth.json')), true);
  const listing = git(memory, ['worktree', 'list', '--porcelain']).stdout;
  assert.doesNotMatch(listing, /memory-run-00000000-0000-4000-8000-000000000001/);
  assert.match(listing, /memory-run-00000000-0000-4000-8000-000000000002/);
  assert.match(listing, /memory-run-00000000-0000-4000-8000-000000000003/);
  assert.equal(health(home).checks['worktrees:memory-runs'].outcome, 'done');
});

test('three corrupt health snapshots in a week escalate from journaled repairs', async t => {
  const { heal } = await import('../skills/geppetto-adopt/scripts/heal.mjs');
  const home = fixture(t);
  // An older verified rebuild and a missing-snapshot initialization do not count.
  for (const at of [now - 2 * week, now - hour, now, now + day, now + 2 * day]) {
    if (at === now - hour) unlinkSync(resolve(home, healthPath));
    else put(home, healthPath, 'invalid');
    await heal({ home, now: at });
    if (at === now + day) assert.equal(health(home).checks['health:store'].state, 'ok');
  }
  const check = health(home).checks['health:store'];
  assert.equal(check.state, 'blocked');
  assert.deepEqual(check.heals7d, [iso(now), iso(now + day), iso(now + 2 * day)]);
  assert.match(check.escalation, /recurring fault/i);
  assert.match(context(await start(home, { now: () => now + 2 * day })), /recurring fault/i);
});

async function waitFor(done) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (done()) return;
    await delay(25);
  }
  assert.fail('Detached repair did not finish.');
}
