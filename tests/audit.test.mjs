import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, symlinkSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { fixture, put, get, invoke, git, config, scripts } from './helpers.mjs';

test('learning readiness requires an initial Git commit, not just an available CLI', t => {
  const cwd = fixture(t), home = fixture(t), bin = fixture(t);
  put(bin, process.platform === 'win32' ? 'codex.exe' : 'codex', 'fixture');
  const env = { PATH: `${bin}${delimiter}${process.env.PATH}` };
  const learning = () => { const r = invoke('audit.mjs', ['--json'], { cwd, home, env }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout).learning; };
  assert.equal(learning().enabled, false); assert.match(learning().action, /Git.*commit/i);
  git(cwd, ['init', '-q']);
  assert.equal(learning().enabled, false);
  git(cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Initial revision']);
  assert.deepEqual(learning(), { enabled: true, action: null });
  put(cwd, '.geppetto/config.json', { ...config(), hooks: { signalLearning: { enabled: false } } });
  assert.deepEqual(learning(), { enabled: false, action: null });
});

test('audit inventories an empty project without claiming active harness capabilities', t => {
  const cwd = fixture(t); const r = invoke('audit.mjs', ['--json'], { cwd }); assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout); assert.deepEqual(report.installed, []); assert.equal(report.memory.status, 'absent');
  assert.equal(invoke('audit.mjs', ['--nope'], { cwd }).status, 2);
});

test('post-install audit executes installed green/red gate fixtures and validates project config and instruction budget', t => {
  const cwd = fixture(t), packageRoot = fixture(t); cpSync(scripts, packageRoot, { recursive: true });
  const audit = (...args) => invoke(resolve(packageRoot, 'audit.mjs'), args, { cwd }); put(cwd, 'AGENTS.md', '# Router\n'); put(cwd, '.geppetto/config.json', config());
  let r = audit('--verify', '--json'); assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout).verification.map(c => [c.name, c.pass]), [['config', true], ['sections-valid-fixture', true], ['sections-invalid-fixture', true], ['agents-valid-fixture', true], ['agents-invalid-fixture', true], ['project-agents-budget', true]]);
  put(packageRoot, 'gate-sections.mjs', 'process.exit(0)'); r = audit('--verify', '--json'); assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).verification.find(c => c.name === 'sections-invalid-fixture').pass, false);
  put(cwd, '.geppetto/config.json', { version: 1 }); r = audit('--verify', '--json'); assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).verification[0].pass, false);
});

test('memory audit merges user/project settings and observes clone, indexes and remote using temporary repositories', t => {
  const cwd = fixture(t); const home = fixture(t); const memory = fixture(t); git(memory, ['init', '-q']); git(memory, ['remote', 'add', 'origin', 'https://example.com/memories.git']); put(memory, 'index.md', '# Index'); put(memory, 'buckets/project/index.md', '# Project');
  put(home, '.geppetto/config.json', { memory: { repo: 'https://example.com/memories.git', localPath: memory, projectBucket: 'user-default' } }); put(cwd, '.geppetto/config.json', { ...config(), memory: { projectBucket: 'project' } });
  let r = invoke('audit.mjs', ['--json'], { cwd, home }); assert.equal(r.status, 0, r.stderr); const result = JSON.parse(r.stdout).memory;
  assert.equal(result.repo, 'https://example.com/memories.git'); assert.equal(result.clone, 'present'); assert.equal(result.rootIndex.status, 'present'); assert.equal(result.projectBucketIndex.status, 'present'); assert.equal(result.remote.status, 'present'); assert.deepEqual(result.remote.names, ['origin']);
  put(cwd, '.geppetto/config.json', { ...config(), memory: { localPath: 'absent', projectBucket: 'project' } }); r = invoke('audit.mjs', ['--json'], { cwd, home }); const missing = JSON.parse(r.stdout).memory; assert.equal(missing.clone, 'absent'); assert.equal(missing.rootIndex.status, 'absent'); assert.equal(missing.remote.status, 'absent');
  put(cwd, '.geppetto/config.json', { ...config(), memory: { projectBucket: '../escape' } }); assert.equal(invoke('audit.mjs', ['--json'], { cwd, home }).status, 1);
});

test('user-only memory configuration reports missing indexes and remote separately from the clone', t => {
  const cwd = fixture(t); const home = fixture(t); const memory = fixture(t); git(memory, ['init', '-q']);
  put(home, '.geppetto/config.json', { memory: { repo: 'https://example.com/memory.git', localPath: memory, projectBucket: 'project' } });
  const r = invoke('audit.mjs', ['--json'], { cwd, home }); assert.equal(r.status, 0, r.stderr); const report = JSON.parse(r.stdout).memory;
  assert.equal(report.clone, 'present'); assert.equal(report.rootIndex.status, 'absent'); assert.equal(report.projectBucketIndex.status, 'absent'); assert.equal(report.remote.status, 'absent');
});

test('verification names live-evidence gaps and fails when the configured memory remote differs', t => {
  const cwd = fixture(t); const home = fixture(t); const memory = fixture(t);
  put(cwd, 'AGENTS.md', '# Router\n');
  git(memory, ['init', '-q']); git(memory, ['remote', 'add', 'origin', 'https://example.com/wrong.git']);
  put(cwd, '.geppetto/config.json', { ...config(), memory: { repo: 'https://example.com/intended.git', localPath: memory } });
  let r = invoke('audit.mjs', ['--verify'], { cwd, home }); assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /PASS config/); assert.match(r.stdout, /FAIL memory-remote-url/);
  assert.doesNotMatch(r.stdout, /NOT VERIFIED/);
  git(memory, ['remote', 'set-url', 'origin', 'https://example.com/intended.git']);
  r = invoke('audit.mjs', ['--verify', '--json'], { cwd, home }); assert.equal(r.status, 0, r.stderr);
  let result = JSON.parse(r.stdout); assert.equal(result.memory.remote.matchesConfigured, true); assert.deepEqual(result.memory.remote.urls, ['https://example.com/intended.git']);
  git(memory, ['remote', 'set-url', '--push', 'origin', 'https://example.com/unintended-push.git']);
  r = invoke('audit.mjs', ['--verify', '--json'], { cwd, home }); assert.equal(r.status, 1); result = JSON.parse(r.stdout); assert.equal(result.memory.remote.matchesConfigured, false);
});


test('memory audit recognizes a repository configured through a directory alias', t => {
  const cwd = fixture(t); const home = fixture(t); const memory = fixture(t); const links = fixture(t);
  git(memory, ['init', '-q']);
  const alias = resolve(links, 'memory');
  symlinkSync(memory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  put(cwd, '.geppetto/config.json', { ...config(), memory: { localPath: alias } });
  const r = invoke('audit.mjs', ['--json'], { cwd, home }); assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).memory.clone, 'present');
});


test('memory audit accepts the same HTTPS repository with an optional .git suffix', t => {
  const cwd = fixture(t); const home = fixture(t); const memory = fixture(t);
  git(memory, ['init', '-q']); git(memory, ['remote', 'add', 'origin', 'https://example.com/memory.git']);
  put(cwd, '.geppetto/config.json', { ...config(), memory: { repo: 'https://example.com/memory', localPath: memory } });
  const r = invoke('audit.mjs', ['--json'], { cwd, home }); assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).memory.remote.matchesConfigured, true);
});

test('audit reports an abandoned learning lock and preserves it', t => {
  const cwd = fixture(t), home = fixture(t), bin = fixture(t);
  put(bin, process.platform === 'win32' ? 'codex.exe' : 'codex', 'fixture');
  git(cwd, ['init', '-q']);
  git(cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Initial revision']);
  put(home, '.geppetto/learn.lock', '12345');
  put(home, 'mock-process.cjs', "process.kill = () => { const error = new Error('no process'); error.code = 'ESRCH'; throw error; };");
  const result = invoke('audit.mjs', ['--json'], { cwd, home, env: { PATH: `${bin}${delimiter}${process.env.PATH}`, NODE_OPTIONS: `--require=${resolve(home, 'mock-process.cjs')}` } });
  assert.equal(result.status, 0, result.stderr);
  const learning = JSON.parse(result.stdout).learning;
  assert.equal(learning.enabled, false);
  assert.match(learning.action, /PID.*exited.*remov/i);
  assert.equal(get(home, '.geppetto/learn.lock'), '12345');
  const text = invoke('audit.mjs', [], { cwd, home, env: { PATH: `${bin}${delimiter}${process.env.PATH}`, NODE_OPTIONS: `--require=${resolve(home, 'mock-process.cjs')}` } });
  assert.match(text.stdout, /Signal learning: not ready;.*PID/);
});


test('audit distinguishes live, unverifiable and invalid learning lock owners', t => {
  const cwd = fixture(t), home = fixture(t), bin = fixture(t);
  put(bin, process.platform === 'win32' ? 'codex.exe' : 'codex', 'fixture');
  git(cwd, ['init', '-q']);
  git(cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Initial revision']);
  const env = { PATH: `${bin}${delimiter}${process.env.PATH}`, NODE_OPTIONS: `--require=${resolve(home, 'mock-process.cjs')}` };
  const learning = () => { const result = invoke('audit.mjs', ['--json'], { cwd, home, env }); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout).learning; };
  put(home, 'mock-process.cjs', 'process.kill = () => true;');
  assert.deepEqual(learning(), { enabled: true, action: null });
  put(home, '.geppetto/learn.lock', '12345');
  assert.deepEqual(learning(), { enabled: true, action: null });
  put(home, 'mock-process.cjs', "process.kill = () => { const error = new Error('permission'); error.code = 'EPERM'; throw error; };");
  assert.match(learning().action, /status could not be verified/);
  assert.equal(learning().enabled, false);
  for (const owner of ['', '0', '-1', '12abc', '2147483648']) {
    put(home, '.geppetto/learn.lock', owner);
    const result = learning(); assert.equal(result.enabled, false); assert.match(result.action, /owner is invalid/);
    assert.equal(get(home, '.geppetto/learn.lock'), owner);
  }
  rmSync(resolve(home, '.geppetto/learn.lock'));
  mkdirSync(resolve(home, '.geppetto/learn.lock'));
  const unreadable = learning(); assert.equal(unreadable.enabled, false); assert.match(unreadable.action, /could not be read/);
});
