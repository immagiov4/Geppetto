import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { fixture, put, get, invoke, git, repo, config } from './helpers.mjs';
import { reconcileMachine } from '../skills/geppetto-adopt/scripts/machine.mjs';

const registration = name => ({ scheduler: 'fixture', id: name, cadence: 'weekly', nextRun: '2026-11-02T09:00:00', disable: `fixture disable ${name}` });
const jobs = Object.fromEntries(['curate-skills', 'maintain-memory'].map(name => [name, registration(name)]));
function setup(t) {
  const home = fixture(t), project = resolve(fixture(t), 'example-app');
  put(project, 'README.md', 'Example');
  return { home, project, options: { home, pluginHooks: true, jobs, unscheduler: async () => true } };
}

test('fresh installation asks one informed memory question before writing files', t => {
  const { home, project } = setup(t);
  const result = invoke('install.mjs', ['--target', 'codex', '--project', project, '--plugin-hooks'], { cwd: project, home, memoryChoice: null });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Local Git folder \(recommended\).*geppetto-memory/s);
  assert.match(result.stderr, /Private GitHub repo.*sync across machines/s);
  assert.match(result.stderr, /Only Claude\/Codex's own memory.*separate per tool and per machine/s);
  assert.match(result.stderr, /No memory/);
  assert.equal(existsSync(resolve(project, '.geppetto')), false);
});

for (const choice of ['local', 'native', 'none']) test(`${choice} memory choice persists across installation, audit and reruns`, async t => {
  const { home, project } = setup(t);
  const args = ['--target', 'codex', '--project', project, '--plugin-hooks', '--memory', choice];
  let result = invoke('install.mjs', args, { cwd: project, home });
  assert.equal(result.status, 0, result.stderr);
  const user = JSON.parse(get(home, '.geppetto/config.json'));
  assert.equal(user.memory.choice, choice);
  if (choice === 'local') {
    const memory = resolve(home, 'geppetto-memory');
    assert.equal(user.memory.localPath, memory); assert.equal(user.memory.repo, memory);
    assert.match(get(memory, 'index.md'), /Bucket \| Scope \| Holds/);
    assert.match(get(memory, 'index.md'), /preferences.*global/); assert.match(get(memory, 'index.md'), /example-app.*project/);
    assert.match(get(memory, 'buckets/example-app/index.md'), /Claude.*claude\//);
    assert.equal(git(memory, ['rev-parse', '--show-toplevel']).status, 0);
    assert.equal(JSON.parse(get(project, '.claude/settings.local.json')).autoMemoryDirectory, `${resolve(memory, 'buckets/example-app/claude')}/`);
  } else {
    for (const name of ['SessionStart', 'UserPromptSubmit']) {
      const hook = invoke('memory-hook.mjs', [], { cwd: project, home, input: JSON.stringify({ cwd: project, hook_event_name: name, prompt: 'Remember this' }) });
      assert.equal(hook.status, 0, hook.stderr); assert.deepEqual(JSON.parse(hook.stdout), {});
    }
    assert.equal(existsSync(resolve(home, 'geppetto-memory')), false);
  }
  result = invoke('install.mjs', args.slice(0, -2), { cwd: project, home, memoryChoice: null });
  assert.equal(result.status, 0, result.stderr); assert.doesNotMatch(result.stdout, /Which memory/);
  assert.match(result.stdout, /Memory:.*change.*--memory/i);
  result = invoke('audit.mjs', ['--project', project, '--json'], { cwd: project, home });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).memory.choice, choice);
});

test('GitHub memory creates a private repository and seeds the same local layout', async t => {
  const { home, project, options } = setup(t), calls = [];
  const execute = (command, args, opts) => {
    calls.push([command, ...args]);
    if (command === 'gh') {
      if (args[0] === 'api') return { status: 0, stdout: 'fixture-user\n' };
      assert.deepEqual(args, ['repo', 'create', 'fixture-user/geppetto-memory', '--private', '--source', resolve(home, 'geppetto-memory'), '--remote', 'origin']);
      git(resolve(home, 'geppetto-memory'), ['remote', 'add', 'origin', 'https://github.com/fixture-user/geppetto-memory']);
      return { status: 0, stdout: '' };
    }
    if (['push', 'fetch'].includes(args[0])) return { status: 0, stdout: '' };
    return git(opts.cwd, args, opts);
  };
  await reconcileMachine(project, 'claude', { path: repo }, { ...options, memoryChoice: 'github', execute });
  const memory = JSON.parse(get(home, '.geppetto/config.json')).memory;
  assert.equal(memory.choice, 'github'); assert.equal(memory.repo, 'https://github.com/fixture-user/geppetto-memory');
  assert.match(get(memory.localPath, 'index.md'), /preferences/);
  assert.ok(calls.some(args => args.includes('--private')));
});

test('existing machine memory is reused without asking and Claude directory ownership preserves settings', async t => {
  const { home, project, options } = setup(t), memory = fixture(t);
  git(memory, ['init', '-q']); put(memory, 'index.md', '# Memory\n\n| Bucket | Scope | Holds |\n|---|---|---|\n| [example-app](buckets/example-app/index.md) | project | Lessons |\n');
  put(memory, 'buckets/example-app/index.md', '# Example\n');
  put(project, '.geppetto/config.json', { ...config(), memory: { buckets: ['example-app'] } });
  put(home, '.geppetto/machine.json', { projects: {}, hooks: {}, jobs: {}, keys: {}, memory: { repo: memory, localPath: memory } });
  put(project, '.claude/settings.local.json', { permissions: { allow: ['Read'] }, autoMemoryDirectory: '/prior/location/' });
  await reconcileMachine(project, 'claude', { path: repo }, options);
  let settings = JSON.parse(get(project, '.claude/settings.local.json'));
  assert.deepEqual(settings.permissions, { allow: ['Read'] }); assert.equal(settings.autoMemoryDirectory, `${resolve(memory, 'buckets/example-app/claude')}/`);
  settings.theme = 'dark'; put(project, '.claude/settings.local.json', settings);
  await reconcileMachine(project, 'codex', { path: repo }, options);
  await reconcileMachine(project, 'claude', null, { ...options, uninstall: true });
  assert.equal(JSON.parse(get(project, '.claude/settings.local.json')).autoMemoryDirectory, settings.autoMemoryDirectory);
  await reconcileMachine(project, 'codex', null, { ...options, uninstall: true });
  assert.deepEqual(JSON.parse(get(project, '.claude/settings.local.json')), { permissions: { allow: ['Read'] }, autoMemoryDirectory: '/prior/location/', theme: 'dark' });
});

test('two machines sharing a Git remote deduplicate jobs, force extras and remove only their registrations', async t => {
  const remote = fixture(t); assert.equal(git(remote, ['init', '--bare', '-q']).status, 0);
  const a = setup(t), b = setup(t), calls = [];
  const first = resolve(a.home, 'memory'), second = resolve(b.home, 'memory');
  assert.equal(git(a.home, ['clone', remote, first]).status, 0);
  put(first, 'index.md', '# Memory\n\n| Bucket | Scope | Holds |\n|---|---|---|\n| [example-app](buckets/example-app/index.md) | project | Lessons |\n');
  put(first, 'buckets/example-app/index.md', '# Example\n');
  git(first, ['add', '.']); assert.equal(git(first, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Seed']).status, 0);
  assert.equal(git(first, ['push', '-u', 'origin', 'HEAD']).status, 0);
  assert.equal(git(b.home, ['clone', remote, second]).status, 0);
  b.project = resolve(fixture(t), 'second-app'); put(b.project, 'README.md', 'Second app');
  for (const [machine, localPath] of [[a, first], [b, second]]) {
    put(machine.home, '.geppetto/config.json', { memory: { repo: remote, localPath, ...(machine === a ? { buckets: ['example-app'] } : { choice: 'github' }) } });
    machine.options = { home: machine.home, pluginHooks: true, machineName: machine === a ? 'machine-a' : 'machine-b', scheduler: async name => { calls.push([machine.home, name]); return registration(name); }, unscheduler: async () => true };
  }
  await reconcileMachine(a.project, 'codex', { path: repo }, a.options);
  put(first, 'remote-lesson.md', 'A newer remote lesson.'); git(first, ['add', 'remote-lesson.md']);
  assert.equal(git(first, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Remote lesson']).status, 0);
  assert.equal(git(first, ['push']).status, 0);
  await reconcileMachine(b.project, 'codex', { path: repo }, b.options);
  assert.equal(get(second, 'remote-lesson.md'), 'A newer remote lesson.');
  assert.match(get(second, 'index.md'), /second-app/);
  assert.equal(calls.length, 2); assert.ok(calls.every(([home]) => home === a.home));
  let machine = JSON.parse(get(b.home, '.geppetto/machine.json'));
  assert.equal(machine.jobs['maintain-memory'].machine, 'machine-a'); assert.equal(machine.jobs['maintain-memory'].status, 'scheduled-elsewhere');
  const recap = invoke('install.mjs', ['--target', 'codex', '--project', b.project, '--plugin-hooks'], { cwd: b.project, home: b.home, memoryChoice: null });
  assert.equal(recap.status, 0, recap.stderr); assert.match(recap.stdout, /maintain-memory: already scheduled on machine-a/);
  await reconcileMachine(b.project, 'codex', { path: repo }, { ...b.options, addJobs: ['maintain-memory'] });
  assert.equal(calls.length, 3);
  assert.match(get(second, 'jobs.md'), /machine-b \| maintain-memory/);
  assert.match(git(second, ['log', '-1', '--format=%B']).stdout, /Memory-Event: save/);
  await reconcileMachine(b.project, 'codex', null, { ...b.options, uninstall: true });
  assert.doesNotMatch(get(second, 'jobs.md'), /machine-b/); assert.match(get(second, 'jobs.md'), /machine-a/);
  assert.equal(git(first, ['pull', '--ff-only']).status, 0);
  assert.equal(get(first, 'jobs.md'), get(second, 'jobs.md'));
});

test('CLI uninstall removes the owned Claude key and keeps unrelated settings after reruns', t => {
  const { home, project } = setup(t), args = ['--target', 'claude', '--project', project, '--plugin-hooks'];
  put(project, '.claude/settings.local.json', { permissions: { allow: ['Read'] } });
  for (const extra of [['--memory', 'local'], []]) {
    const result = invoke('install.mjs', [...args, ...extra], { cwd: project, home });
    assert.equal(result.status, 0, result.stderr);
  }
  const removed = invoke('install.mjs', [...args, '--uninstall'], { cwd: project, home });
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(JSON.parse(get(project, '.claude/settings.local.json')), { permissions: { allow: ['Read'] } });
  assert.doesNotMatch(get(resolve(home, 'geppetto-memory'), 'jobs.md'), /fixture \| weekly/);
});

test('a changed native directory survives uninstall and unavailable gh gives an actionable error', async t => {
  const { home, project, options } = setup(t);
  await assert.rejects(reconcileMachine(project, 'codex', { path: repo }, { ...options, memoryChoice: 'github', execute: () => ({ error: { code: 'ENOENT' } }) }), /gh auth login/);
  await reconcileMachine(project, 'claude', { path: repo }, { ...options, memoryChoice: 'local' });
  put(project, '.claude/settings.local.json', { autoMemoryDirectory: '/user-changed/', theme: 'dark' });
  await reconcileMachine(project, 'claude', null, { ...options, uninstall: true });
  assert.deepEqual(JSON.parse(get(project, '.claude/settings.local.json')), { autoMemoryDirectory: '/user-changed/', theme: 'dark' });
});

test('--add-job attaches a local job despite another machine registration', async t => {
  const { home, project, options } = setup(t);
  await reconcileMachine(project, 'codex', { path: repo }, { ...options, memoryChoice: 'local' });
  const memory = resolve(home, 'geppetto-memory');
  put(memory, 'jobs.md', '# Maintenance jobs\n\n| Machine | Job | Scheduler | Cadence | Registered |\n|---|---|---|---|---|\n| another-machine | maintain-memory | fixture | weekly | 2026-10-20 |\n');
  git(memory, ['add', 'jobs.md']); git(memory, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture registration']);
  const machine = JSON.parse(get(home, '.geppetto/machine.json'));
  machine.jobs['maintain-memory'] = { status: 'scheduled-elsewhere', machine: 'another-machine' }; put(home, '.geppetto/machine.json', machine);
  const result = invoke('install.mjs', ['--target', 'codex', '--project', project, '--plugin-hooks', '--add-job', 'maintain-memory'], { cwd: project, home });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(get(home, '.geppetto/machine.json')).jobs['maintain-memory'].status, 'scheduled');
  assert.equal(get(memory, 'jobs.md').split('\n').filter(line => line.includes('| maintain-memory |')).length, 2);
  assert.ok(get(memory, 'jobs.md').includes(`| ${hostname()} | maintain-memory |`));
});
