import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixture, put, get, git, invoke, repo } from './helpers.mjs';
import { reconcileMachine } from '../skills/geppetto-adopt/scripts/machine.mjs';
import { memoryJobs } from '../skills/geppetto-adopt/scripts/memory-jobs.mjs';

const registration = name => ({ id: name, scheduler: 'fixture', cadence: 'weekly', nextRun: '2026-11-02T09:00:00', disable: `fixture disable ${name}` });
function shared(t) {
  const base = fixture(t), remote = resolve(base, 'remote.git');
  assert.equal(git(base, ['init', '--bare', '-q', remote]).status, 0);
  function machine(name) {
    const home = resolve(base, `${name}-home`), project = resolve(base, `${name}-project`), localPath = resolve(base, name);
    assert.equal(git(base, ['clone', remote, localPath]).status, 0);
    put(project, 'README.md', 'Fixture project');
    put(home, '.geppetto/config.json', { memory: { repo: remote, localPath, buckets: ['app'] } });
    return { home, project, localPath, machineName: name, memory: { repo: remote, localPath } };
  }
  const a = machine('A');
  put(a.localPath, 'index.md', '# Memory\n\n| Bucket | Scope | Holds |\n|---|---|---|\n| [app](buckets/app/index.md) | project | Lessons |\n');
  put(a.localPath, 'buckets/app/index.md', '# App\n');
  git(a.localPath, ['add', '.']);
  assert.equal(git(a.localPath, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Seed']).status, 0);
  assert.equal(git(a.localPath, ['push', '-u', 'origin', 'HEAD']).status, 0);
  return { a, b: machine('B'), remote };
}

test('an interrupted uninstall retries machine cleanup after the remote recovers', t => {
  const { a, remote } = shared(t);
  const args = ['--target', 'codex', '--project', a.project];
  const options = { cwd: a.project, home: a.home, memoryChoice: null };
  const installed = invoke('install.mjs', args, options); assert.equal(installed.status, 0, installed.stderr);
  renameSync(remote, `${remote}.offline`);
  const failed = invoke('install.mjs', [...args, '--uninstall'], options); assert.equal(failed.status, 1);
  renameSync(`${remote}.offline`, remote);
  const retried = invoke('install.mjs', [...args, '--uninstall'], options); assert.equal(retried.status, 0, retried.stderr);
  const machine = JSON.parse(get(a.home, '.geppetto/machine.json'));
  assert.equal(machine.projects[a.project], undefined); assert.equal(machine.hooks.codex, undefined);
  assert.doesNotMatch(get(a.localPath, 'jobs.md'), /\| A \|/);
});

test('uninstall stops owned jobs before another machine can attach replacements', async t => {
  const { a, b } = shared(t); const active = new Set();
  const options = m => ({ ...m, pluginHooks: true, scheduler: async name => { active.add(`${m.machineName}/${name}`); return registration(name); }, unscheduler: async name => { active.delete(`${m.machineName}/${name}`); return true; } });
  await reconcileMachine(a.project, 'codex', { path: repo }, options(a));
  await reconcileMachine(a.project, 'codex', null, { ...options(a), uninstall: true });
  assert.equal(active.size, 0);
  await reconcileMachine(b.project, 'codex', { path: repo }, options(b));
  assert.equal(active.size, 2); assert.ok([...active].every(name => name.startsWith('B/')));
});

test('concurrent machines publish ownership before activating jobs and remain retryable', async t => {
  const { a, b } = shared(t), calls = [];
  let reached, release;
  const paused = new Promise(done => { reached = done; });
  const resume = new Promise(done => { release = done; });
  const installA = reconcileMachine(a.project, 'codex', { path: repo }, { ...a, pluginHooks: true, scheduler: async name => { calls.push(`A/${name}`); reached(); await resume; return registration(name); } });
  await paused;
  try { await reconcileMachine(b.project, 'codex', { path: repo }, { ...b, pluginHooks: true, scheduler: async name => { calls.push(`B/${name}`); return registration(name); } }); }
  finally { release(); }
  await installA;
  assert.equal(calls.length, 2); assert.ok(calls.every(name => name.startsWith('A/')));
  await reconcileMachine(b.project, 'codex', { path: repo }, { ...b, pluginHooks: true, scheduler: async name => { calls.push(`B/${name}`); return registration(name); } });
  assert.equal(calls.length, 2);
});

test('registering jobs never publishes unrelated locally committed memories', async t => {
  const { a, b } = shared(t);
  put(a.localPath, 'local-review.md', 'Keep this local.'); git(a.localPath, ['add', 'local-review.md']);
  assert.equal(git(a.localPath, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Keep local for review']).status, 0);
  await assert.rejects(async () => { const registry = await memoryJobs(a.memory); await registry.update(rows => rows.push({ machine: 'A', job: 'maintain-memory', scheduler: 'fixture', cadence: 'weekly', registered: 'now' })); }, /local commits|separate synchronization/i);
  assert.equal(git(b.localPath, ['pull', '--ff-only']).status, 0);
  assert.equal(existsSync(resolve(b.localPath, 'local-review.md')), false);
});

test('a losing registry writer rereads ownership without divergent local commits', async t => {
  const { a, b } = shared(t);
  const first = await memoryJobs(a.memory), second = await memoryJobs(b.memory);
  const claim = machine => rows => {
    const owner = rows.find(row => row.job === 'maintain-memory');
    if (owner) return owner.machine;
    rows.push({ machine, job: 'maintain-memory', scheduler: 'pending', cadence: 'pending', registered: 'now' });
    return machine;
  };
  assert.equal(await first.update(claim('A')), 'A');
  assert.equal(await second.update(claim('B')), 'A');
  assert.doesNotMatch(get(b.localPath, 'jobs.md'), /\| B \|/);
  assert.equal(git(b.localPath, ['rev-parse', 'HEAD']).stdout, git(a.localPath, ['rev-parse', 'HEAD']).stdout);
  assert.equal(git(b.localPath, ['status', '--porcelain']).stdout, '');
});

test('registry commits preserve unrelated staged changes', async t => {
  const { a, b } = shared(t);
  put(a.localPath, 'keep-staged.md', 'Unrelated work'); git(a.localPath, ['add', 'keep-staged.md']);
  const staged = git(a.localPath, ['diff', '--cached', '--binary']).stdout;
  const registry = await memoryJobs(a.memory);
  await registry.update(rows => rows.push({ machine: 'A', job: 'maintain-memory', scheduler: 'pending', cadence: 'pending', registered: 'now' }));
  assert.equal(git(a.localPath, ['diff', '--cached', '--binary']).stdout, staged);
  assert.equal(git(b.localPath, ['pull', '--ff-only']).status, 0);
  assert.equal(existsSync(resolve(b.localPath, 'keep-staged.md')), false);
});

test('an interrupted older registry publication is retried without publishing other work', async t => {
  const { a, b } = shared(t);
  put(a.localPath, 'jobs.md', '# Maintenance jobs\n\n| Machine | Job | Scheduler | Cadence | Registered |\n|---|---|---|---|---|\n| A | maintain-memory | pending | pending | now |\n');
  git(a.localPath, ['add', 'jobs.md']);
  assert.equal(git(a.localPath, ['-c', 'user.name=Geppetto', '-c', 'user.email=geppetto@localhost', 'commit', '-qm', 'Register memory maintenance']).status, 0);
  const registry = await memoryJobs(a.memory);
  await registry.update(() => {});
  assert.equal(git(b.localPath, ['pull', '--ff-only']).status, 0);
  assert.match(get(b.localPath, 'jobs.md'), /\| A \| maintain-memory/);
});

test('unconfirmed external cancellation retains the shared registration and retries explicitly', async t => {
  const { a } = shared(t);
  const jobs = Object.fromEntries(['curate-skills', 'maintain-memory'].map(name => [name, registration(name)]));
  const options = { ...a, pluginHooks: true, jobs };
  await reconcileMachine(a.project, 'codex', { path: repo }, options);
  await assert.rejects(reconcileMachine(a.project, 'codex', null, { ...options, uninstall: true }), /disabled confirmation/);
  assert.match(get(a.localPath, 'jobs.md'), /\| A \|/);
  assert.ok(JSON.parse(get(a.home, '.geppetto/machine.json')).projects[a.project]);
  const confirmed = Object.fromEntries(Object.entries(jobs).map(([name, job]) => [name, { ...job, status: 'disabled' }]));
  await reconcileMachine(a.project, 'codex', null, { ...options, jobs: confirmed, uninstall: true });
  assert.doesNotMatch(get(a.localPath, 'jobs.md'), /\| A \|/);
  assert.equal(JSON.parse(get(a.home, '.geppetto/machine.json')).jobs['maintain-memory'].status, 'disabled');
});
