import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixture, put, get, invoke, scripts } from './helpers.mjs';

function source(t) {
  const root = fixture(t); cpSync(scripts, resolve(root, 'skills/geppetto-adopt/scripts'), { recursive: true });
  put(root, 'package.json', { name: 'geppetto', version: '0.1.0' });
  put(root, 'skills/geppetto-adopt/SKILL.md', '---\nname: geppetto-adopt\ndescription: Adopt\n---\nAdopt');
  put(root, 'skills/geppetto-example/SKILL.md', '---\nname: geppetto-example\ndescription: Example\n---\nOriginal');
  return { root, install: resolve(root, 'skills/geppetto-adopt/scripts/install.mjs') };
}

test('dry run is read-only, installation ships standalone gates, update reconciles hashes, uninstall preserves foreign files', t => {
  const cwd = fixture(t); const { root, install } = source(t); const args = ['--target', 'codex', '--project', cwd];
  let r = invoke(install, [...args, '--dry-run'], { cwd }); assert.equal(r.status, 0, r.stderr); assert.equal(existsSync(resolve(cwd, '.geppetto')), false);
  r = invoke(install, args, { cwd }); assert.equal(r.status, 0, r.stderr); assert.match(get(cwd, '.agents/skills/geppetto-example/SKILL.md'), /Original$/);
  r = invoke(resolve(cwd, '.geppetto/bin/gate-sections.mjs'), ['--pr', '-'], { cwd, input: '## Observability\nLogs' }); assert.equal(r.status, 0, r.stderr);
  put(cwd, '.agents/skills/foreign/SKILL.md', 'Keep'); put(root, 'skills/geppetto-example/SKILL.md', 'Updated');
  assert.equal(invoke(install, args, { cwd }).status, 0); assert.equal(get(cwd, '.agents/skills/geppetto-example/SKILL.md'), 'Updated');
  assert.equal(invoke(install, [...args, '--uninstall'], { cwd }).status, 0); assert.equal(existsSync(resolve(cwd, '.agents/skills/geppetto-example/SKILL.md')), false); assert.equal(get(cwd, '.agents/skills/foreign/SKILL.md'), 'Keep');
});

test('local modifications block update and uninstall before any file is changed', t => {
  const cwd = fixture(t); const { root, install } = source(t); const args = ['--target', 'claude', '--project', cwd];
  assert.equal(invoke(install, args, { cwd }).status, 0);
  put(cwd, '.claude/skills/geppetto-example/SKILL.md', 'My local edits'); put(root, 'skills/geppetto-adopt/SKILL.md', 'New adopt');
  for (const extra of [[], ['--uninstall']]) { const r = invoke(install, [...args, ...extra], { cwd }); assert.equal(r.status, 1); assert.match(r.stderr, /Local edits need reconciliation/); }
  assert.match(get(cwd, '.claude/skills/geppetto-adopt/SKILL.md'), /Adopt$/); assert.equal(get(cwd, '.claude/skills/geppetto-example/SKILL.md'), 'My local edits');
});

test('user install selects the user home and multiple targets retain shared gates until the last owner uninstalls', t => {
  const cwd = fixture(t); const home = fixture(t); const { root, install } = source(t);
  for (const target of ['codex', 'agents']) { const r = invoke(install, ['--target', target, '--user'], { cwd, home }); assert.equal(r.status, 0, r.stderr); }
  assert.equal(existsSync(resolve(cwd, '.agents')), false); assert.match(get(home, '.agents/skills/geppetto-example/SKILL.md'), /Original$/);
  put(root, 'skills/geppetto-adopt/scripts/gate-sections.mjs', `${get(root, 'skills/geppetto-adopt/scripts/gate-sections.mjs')}\n// Updated shared gate\n`);
  const update = invoke(install, ['--target', 'agents', '--user'], { cwd, home }); assert.equal(update.status, 0, update.stderr);
  assert.match(get(home, '.geppetto/bin/gate-sections.mjs'), /Updated shared gate/);
  assert.equal(invoke(install, ['--target', 'codex', '--user', '--uninstall'], { cwd, home }).status, 0); assert.equal(existsSync(resolve(home, '.geppetto/bin/gate-sections.mjs')), true);
  assert.equal(invoke(install, ['--target', 'agents', '--user', '--uninstall'], { cwd, home }).status, 0); assert.equal(existsSync(resolve(home, '.geppetto/bin/gate-sections.mjs')), false);
  assert.equal(invoke(install, ['--target', 'codex', '--user', '--project', cwd], { cwd, home }).status, 2);
});

test('unowned conflicts and forged ownership paths cannot overwrite or remove outside files', t => {
  const cwd = fixture(t); const { install } = source(t); const args = ['--target', 'codex', '--project', cwd];
  put(cwd, '.agents/skills/geppetto-example/SKILL.md', 'Foreign'); assert.match(invoke(install, args, { cwd }).stderr, /not owned/);
  put(cwd, '.agents/skills/geppetto-example/SKILL.md', '---\nname: geppetto-example\ndescription: Example\n---\nOriginal');
  assert.equal(invoke(install, args, { cwd }).status, 0);
  assert.equal(get(cwd, '.agents/skills/geppetto-example/SKILL.md'), '---\nname: geppetto-example\ndescription: Example\n---\nOriginal');
  put(cwd, '.geppetto/install.json', { version: 1, installations: { codex: { files: { '../outside.txt': 'a'.repeat(64) } } } });
  const r = invoke(install, [...args, '--uninstall'], { cwd }); assert.equal(r.status, 1); assert.match(r.stderr, /escapes its root/);
});

test('relocated bin and installed skill installers resolve recorded source and fail safely without provenance', t => {
  const cwd = fixture(t); const { root, install } = source(t); const args = ['--target', 'codex', '--project', cwd];
  assert.equal(invoke(install, args, { cwd }).status, 0);
  const manifest = JSON.parse(get(cwd, '.geppetto/install.json'));
  assert.deepEqual(manifest.source, { path: root, version: '0.1.0' });
  for (const copy of ['.geppetto/bin/install.mjs', '.agents/skills/geppetto-adopt/scripts/install.mjs']) {
    const r = invoke(resolve(cwd, copy), [...args, '--dry-run'], { cwd });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /0 file changes/); assert.doesNotMatch(r.stdout, /remove /);
  }
  delete manifest.source; put(cwd, '.geppetto/install.json', manifest);
  const r = invoke(resolve(cwd, '.geppetto/bin/install.mjs'), [...args, '--dry-run'], { cwd });
  assert.equal(r.status, 1); assert.match(r.stderr, /No recorded package source/); assert.doesNotMatch(r.stdout, /remove /);
  assert.match(get(cwd, '.agents/skills/geppetto-example/SKILL.md'), /Original$/);
});

test('a user-installed skill can adopt a fresh project using its own recorded package provenance', t => {
  const { install } = source(t);
  for (const target of ['codex', 'claude']) {
    const cwd = fixture(t); const home = fixture(t); const skillRoot = target === 'claude' ? '.claude/skills' : '.agents/skills';
    let r = invoke(install, ['--target', target, '--user'], { cwd, home }); assert.equal(r.status, 0, r.stderr);
    const copy = resolve(home, skillRoot, 'geppetto-adopt/scripts/install.mjs');
    r = invoke(copy, ['--target', target, '--project', cwd], { cwd, home }); assert.equal(r.status, 0, r.stderr);
    assert.match(get(cwd, `${skillRoot}/geppetto-example/SKILL.md`), /Original$/);
    assert.deepEqual(JSON.parse(get(cwd, '.geppetto/install.json')).source, JSON.parse(get(home, '.geppetto/install.json')).source);
  }
});

test('preflight lists every unowned overlap with both hashes and adopts only identical bytes', t => {
  const cwd = fixture(t); const { root, install } = source(t); const args = ['--target', 'codex', '--project', cwd];
  put(root, 'skills/another/SKILL.md', 'Another');
  put(cwd, '.agents/skills/another/SKILL.md', 'Conflict one');
  put(cwd, '.agents/skills/geppetto-adopt/SKILL.md', 'Conflict two');
  put(cwd, '.agents/skills/geppetto-example/SKILL.md', get(root, 'skills/geppetto-example/SKILL.md'));
  let r = invoke(install, [...args, '--dry-run'], { cwd });
  assert.equal(r.status, 1); assert.match(r.stdout, /another\/SKILL.md \| [a-f\d]{64} \| [a-f\d]{64} \| conflict/);
  assert.match(r.stdout, /geppetto-adopt\/SKILL.md.*conflict/); assert.match(r.stdout, /geppetto-example\/SKILL.md.*adopt-identical/);
  assert.equal(existsSync(resolve(cwd, '.geppetto/install.json')), false);
  for (const name of ['another', 'geppetto-adopt']) put(cwd, `.agents/skills/${name}/SKILL.md`, get(root, `skills/${name}/SKILL.md`));
  r = invoke(install, args, { cwd }); assert.equal(r.status, 0, r.stderr);
  assert.equal(Object.keys(JSON.parse(get(cwd, '.geppetto/install.json')).installations.codex.files).filter(p => /SKILL.md$/.test(p)).length, 3);
});

test('generated adoption files are owned, retained on update and protected during uninstall', t => {
  const cwd = fixture(t); const { install } = source(t); const args = ['--target', 'codex', '--project', cwd];
  const generated = ['AGENTS.md', 'CLAUDE.md', '.geppetto/config.json', '.geppetto/authorizations', '.claude/settings.json', '.codex/hooks.json', '.github/workflows/pr-gate.yml'];
  for (const path of generated) put(cwd, path, `Owned ${path}`);
  let r = invoke(install, [...args, '--record-generated', ...generated], { cwd }); assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(get(cwd, '.geppetto/install.json')).installations.codex;
  assert.deepEqual(state.generated, [...generated].sort()); for (const path of generated) assert.match(state.files[path], /^[a-f\d]{64}$/);
  r = invoke(install, [...args, '--dry-run'], { cwd }); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /0 file changes/);
  put(cwd, '.codex/hooks.json', 'Host edit'); r = invoke(install, [...args, '--uninstall'], { cwd }); assert.equal(r.status, 1); assert.match(r.stderr, /Local edits/);
  assert.equal(get(cwd, 'AGENTS.md'), 'Owned AGENTS.md'); put(cwd, '.codex/hooks.json', 'Owned .codex/hooks.json');
  r = invoke(install, [...args, '--uninstall'], { cwd }); assert.equal(r.status, 0, r.stderr); for (const path of generated) assert.equal(existsSync(resolve(cwd, path)), false);
});
