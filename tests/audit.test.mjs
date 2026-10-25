import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixture, put, invoke, git, config, scripts } from './helpers.mjs';

test('audit inventories an empty project without claiming active harness capabilities', t => {
  const cwd = fixture(t); const r = invoke('audit.mjs', ['--json'], { cwd }); assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout); assert.equal(report.projectFiles['AGENTS.md'], 'absent'); assert.equal(report.memory.status, 'absent'); assert.equal(report.harnesses.codex.skillLoading.status, 'unverifiable'); assert.equal(report.harnesses.claude.scheduling.status, 'unverifiable');
  assert.equal(invoke('audit.mjs', ['--nope'], { cwd }).status, 2);
});

test('post-install audit executes installed green/red gate fixtures and validates project config and instruction budget', t => {
  const cwd = fixture(t); cpSync(scripts, resolve(cwd, '.geppetto/bin'), { recursive: true }); put(cwd, 'AGENTS.md', '# Router\n'); put(cwd, '.geppetto/config.json', config());
  let r = invoke('audit.mjs', ['--verify', '--json'], { cwd }); assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout).verification.map(c => [c.name, c.pass]), [['config', true], ['sections-valid-fixture', true], ['sections-invalid-fixture', true], ['agents-valid-fixture', true], ['agents-invalid-fixture', true], ['project-agents-budget', true]]);
  put(cwd, '.geppetto/bin/gate-sections.mjs', 'process.exit(0)'); r = invoke('audit.mjs', ['--verify', '--json'], { cwd }); assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).verification.find(c => c.name === 'sections-invalid-fixture').pass, false);
  put(cwd, '.geppetto/config.json', { version: 1 }); r = invoke('audit.mjs', ['--verify', '--json'], { cwd }); assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).verification[0].pass, false);
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
  cpSync(scripts, resolve(cwd, '.geppetto/bin'), { recursive: true }); put(cwd, 'AGENTS.md', '# Router\n');
  git(memory, ['init', '-q']); git(memory, ['remote', 'add', 'origin', 'https://example.com/wrong.git']);
  put(cwd, '.geppetto/config.json', { ...config(), memory: { repo: 'https://example.com/intended.git', localPath: memory } });
  let r = invoke('audit.mjs', ['--verify'], { cwd, home }); assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /PASS config/); assert.match(r.stdout, /FAIL memory-remote-url/);
  for (const gap of ['hook-trust', 'instruction-loading', 'skill-loading', 'remote-ci', 'provider-spend-limits', 'host-affected-file-check']) assert.match(r.stdout, new RegExp(`NOT VERIFIED ${gap}`));
  git(memory, ['remote', 'set-url', 'origin', 'https://example.com/intended.git']);
  r = invoke('audit.mjs', ['--verify', '--json'], { cwd, home }); assert.equal(r.status, 0, r.stderr);
  let result = JSON.parse(r.stdout); assert.equal(result.memory.remote.matchesConfigured, true); assert.deepEqual(result.memory.remote.urls, ['https://example.com/intended.git']);
  git(memory, ['remote', 'set-url', '--push', 'origin', 'https://example.com/unintended-push.git']);
  r = invoke('audit.mjs', ['--verify', '--json'], { cwd, home }); assert.equal(r.status, 1); result = JSON.parse(r.stdout); assert.equal(result.memory.remote.matchesConfigured, false);
});
