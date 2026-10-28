import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, put, get, invoke, git, repo } from './helpers.mjs';

const gateSha = 'a'.repeat(40);
const digest = content => createHash('sha256').update(content).digest('hex');
function legacy(t, targets = ['codex']) {
  const cwd = fixture(t), home = fixture(t), source = fixture(t);
  for (const path of ['skills', 'hooks']) cpSync(resolve(repo, path), resolve(source, path), { recursive: true });
  put(source, 'package.json', { name: 'geppetto', version: '0.2.0' });
  const install = (target = 'codex', extra = [], root = cwd) => invoke(resolve(source, 'skills/geppetto-adopt/scripts/install.mjs'), ['--target', target, '--project', root, '--gate-sha', gateSha, ...extra], { cwd: root, home });
  assert.equal(install(targets[0], ['--begin']).status, 0);
  for (const command of [['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) assert.equal(git(cwd, command).status, 0);
  for (const target of targets) { const result = install(target); assert.equal(result.status, 0, result.stderr); }
  const state = JSON.parse(get(cwd, '.geppetto/install.json'));
  for (const target of targets) {
    const prefix = target === 'claude' ? '.claude/skills' : '.agents/skills';
    const path = `${prefix}/geppetto-verify/SKILL.md`;
    const content = 'Run `node .geppetto/bin/gate-sections.mjs --pr -`';
    put(cwd, path, content); state.installations[target].files[path] = digest(content);
    for (const name of ['common.mjs', 'gate-agents.mjs', 'gate-sections.mjs', 'pr-event.mjs', 'turn-checks.mjs', 'turn-checks.json']) {
      const path = `.geppetto/bin/${name}`, content = get(repo, `skills/geppetto-adopt/scripts/${name}`);
      put(cwd, path, content); state.installations[target].files[path] = digest(content);
    }
  }
  const workflow = '.github/workflows/pr-gate.yml'; put(cwd, workflow, 'legacy workflow\n');
  for (const entry of Object.values(state.installations)) entry.files[workflow] = digest('legacy workflow\n');
  put(cwd, '.geppetto/install.json', state);
  put(cwd, '.agents/skills/foreign/SKILL.md', 'Unrelated project skill');
  assert.equal(git(cwd, ['add', '-f', '.']).status, 0); assert.equal(git(cwd, ['commit', '-qm', 'Legacy adoption']).status, 0);
  return { cwd, home, source, install };
}

test('Codex-only update migrates Claude commands before retiring shared gates', t => {
  const { cwd, home, install } = legacy(t, ['claude', 'codex']);
  assert.equal(invoke(resolve(cwd, '.geppetto/bin/gate-sections.mjs'), ['--pr', '-'], { cwd, home, input: '## Observability\nProof' }).status, 0);
  const result = install(); assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(get(cwd, '.claude/skills/geppetto-verify/SKILL.md'), /\.geppetto\/bin\//);
  assert.equal(existsSync(resolve(cwd, '.geppetto/bin')), false);
  const gate = invoke(resolve(cwd, '.claude/skills/geppetto-adopt/scripts/gate-sections.mjs'), ['--pr', '-'], { cwd, home, input: '## Observability\nProof' });
  assert.equal(gate.status, 0, gate.stderr);
});

test('cross-target local edits block the whole migration and dry runs preserve files and index', t => {
  const { cwd, install } = legacy(t, ['claude', 'codex']);
  const state = get(cwd, '.geppetto/install.json'), index = git(cwd, ['diff', '--cached', '--binary']).stdout;
  let result = install('codex', ['--dry-run']); assert.equal(result.status, 0, result.stderr);
  assert.equal(get(cwd, '.geppetto/install.json'), state); assert.equal(git(cwd, ['diff', '--cached', '--binary']).stdout, index);
  put(cwd, '.claude/skills/geppetto-verify/SKILL.md', 'Local edit');
  result = install(); assert.equal(result.status, 1); assert.match(result.stderr, /Local edits need reconciliation/);
  assert.equal(get(cwd, '.geppetto/install.json'), state); assert.equal(existsSync(resolve(cwd, '.geppetto/bin/gate-sections.mjs')), true);
  assert.match(get(cwd, '.agents/skills/geppetto-verify/SKILL.md'), /\.geppetto\/bin/);
});

test('migration commit retires owned files and registry while preserving unrelated staged work', t => {
  const { cwd, install } = legacy(t);
  put(cwd, 'unrelated.txt', 'Keep staged'); assert.equal(git(cwd, ['add', 'unrelated.txt']).status, 0);
  let result = install(); assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(resolve(cwd, '.geppetto/install.json')), true);
  assert.equal(git(cwd, ['ls-files', '.geppetto/install.json']).stdout.trim(), '');
  // A repeated update must retain deletions until the installation is finalized.
  result = install(); assert.equal(result.status, 0, result.stderr);
  unlinkSync(resolve(cwd, '.agents/skills/foreign/SKILL.md'));
  assert.equal(git(cwd, ['add', '-u']).status, 0);
  result = install('codex', ['--commit']); assert.equal(result.status, 0, result.stderr);
  assert.equal(git(cwd, ['ls-tree', '-r', '--name-only', 'HEAD', '.geppetto/bin', '.geppetto/install.json']).stdout.trim(), '');
  assert.deepEqual(git(cwd, ['diff', '--cached', '--name-only']).stdout.trim().split('\n'), ['.agents/skills/foreign/SKILL.md', 'unrelated.txt']);
  assert.doesNotMatch(git(cwd, ['status', '--short']).stdout, /\.geppetto\/bin/);
  assert.equal(existsSync(resolve(cwd, '.geppetto/install.json')), true);
});

test('a fresh clone of the migration commit reinstalls with the same gate revision', t => {
  const { cwd, install } = legacy(t);
  let result = install(); assert.equal(result.status, 0, result.stderr);
  result = install('codex', ['--commit']); assert.equal(result.status, 0, result.stderr);
  const clone = resolve(fixture(t), 'clone'); assert.equal(git(cwd, ['clone', '--quiet', cwd, clone]).status, 0);
  result = install('codex', ['--plugin-hooks'], clone); assert.equal(result.status, 0, result.stderr);
});

test('explicitly recorded generated edits update shared ownership across installed targets', t => {
  const { cwd, install } = legacy(t, ['claude', 'codex']);
  put(cwd, 'AGENTS.md', '# Generated router');
  for (const target of ['claude', 'codex']) {
    const result = install(target, ['--record-generated', 'AGENTS.md']); assert.equal(result.status, 0, result.stderr);
  }
  put(cwd, 'AGENTS.md', '# Updated generated router');
  const result = install('codex', ['--record-generated', 'AGENTS.md']); assert.equal(result.status, 0, result.stderr);
  for (const entry of Object.values(JSON.parse(get(cwd, '.geppetto/install.json')).installations)) assert.equal(entry.files['AGENTS.md'], digest(get(cwd, 'AGENTS.md')));
});
