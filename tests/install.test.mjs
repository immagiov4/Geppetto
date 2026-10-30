import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, put, get, invoke, git, scripts, repo } from './helpers.mjs';
import { handleEvent } from '../skills/geppetto-adopt/scripts/hook.mjs';

test('adoption initializes a new project and commits only owned files as its first revision', async t => {
  const cwd = fixture(t), home = fixture(t); const { install } = source(t);
  const args = ['--target', 'codex', '--project', cwd, '--plugin-hooks'];
  put(cwd, 'app.txt', 'Existing application');
  let result = invoke(install, [...args, '--begin', '--dry-run'], { cwd, home });
  assert.equal(result.status, 0, result.stderr); assert.equal(existsSync(resolve(cwd, '.git')), false);
  result = invoke(install, [...args, '--begin'], { cwd, home }); assert.equal(result.status, 0, result.stderr);
  assert.equal(git(cwd, ['branch', '--show-current']).stdout.trim(), 'geppetto-install');
  git(cwd, ['config', 'user.name', 'Fixture']); git(cwd, ['config', 'user.email', 'fixture@example.invalid']);
  git(cwd, ['add', 'app.txt']);
  result = invoke(install, args, { cwd, home }); assert.equal(result.status, 0, result.stderr);
  result = invoke(install, [...args, '--commit'], { cwd, home }); assert.equal(result.status, 0, result.stderr);
  assert.equal(git(cwd, ['rev-parse', '--verify', 'HEAD']).status, 0);
  assert.doesNotMatch(git(cwd, ['show', '--format=', '--name-only', 'HEAD']).stdout, /app.txt/);
  assert.equal(git(cwd, ['diff', '--cached', '--name-only']).stdout.trim(), 'app.txt');
  assert.equal(get(cwd, 'app.txt'), 'Existing application');
  const ignored = get(cwd, '.geppetto/.gitignore');
  const event = { cwd, session_id: 'first-real-use', turn_id: 'first', tool_name: 'Read', tool_input: { file_path: resolve(cwd, 'app.txt') } };
  for (const hook_event_name of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) await handleEvent({ ...event, hook_event_name }, { home, launchLearning: async () => assert.fail('Idle installation must not launch learning') });
  assert.equal(get(cwd, '.geppetto/.gitignore'), ignored, 'the first hook cycle must not modify the committed installation');
  assert.equal(git(cwd, ['diff', '--name-only']).stdout.trim(), '', 'runtime activity must leave committed installation files clean');
});

for (const target of ['claude', 'codex']) test(`${target} plugin adoption stays small, owns only installation files and finalizes on a local branch`, t => {
  const cwd = fixture(t), home = fixture(t); const { install } = source(t);
  const args = ['--target', target, '--project', cwd, '--plugin-hooks'];
  for (const command of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) assert.equal(git(cwd, command).status, 0);
  put(cwd, 'README.md', 'Original project'); git(cwd, ['add', '.']); git(cwd, ['commit', '-qm', 'baseline']);
  put(cwd, 'unrelated.txt', 'Keep staged'); git(cwd, ['add', 'unrelated.txt']);
  let result = invoke(install, [...args, '--begin'], { cwd, home }); assert.equal(result.status, 0, result.stderr);
  assert.equal(git(cwd, ['branch', '--show-current']).stdout.trim(), 'geppetto-install');
  const generated = ['AGENTS.md', 'CLAUDE.md', '.github/workflows/pr-gate.yml'];
  for (const path of generated.filter(path => !path.endsWith('.yml'))) put(cwd, path, path === 'CLAUDE.md' ? '@AGENTS.md' : '# Installation');
  result = invoke(install, [...args, '--record-generated', ...generated], { cwd, home }); assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(get(cwd, '.geppetto/install.json')).installations[target];
  assert.equal(state.plugin, true);
  assert.ok(Object.keys(state.files).length <= 13);
  assert.deepEqual(Object.keys(state.files).filter(p => p.startsWith('.geppetto/bin/')).sort(), []);
  assert.equal(existsSync(resolve(cwd, target === 'claude' ? '.claude/skills' : '.agents/skills')), false);
  put(home, 'event.json', { pull_request: { body: '## Observability\nSynthetic event.' } });
  result = invoke(resolve(install, '../pr-event.mjs'), [], { cwd, home, env: { GITHUB_EVENT_PATH: resolve(home, 'event.json') } }); assert.equal(result.status, 0, result.stderr);
  result = invoke(install, ['--target', target, '--project', cwd, '--dry-run'], { cwd, home }); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /0 file changes/);
  put(cwd, 'docs/geppetto-installation.md', 'Unowned evidence');
  result = invoke(install, [...args, '--record-generated', 'docs/geppetto-installation.md'], { cwd, home }); assert.equal(result.status, 2);
  result = invoke(install, [...args, '--commit'], { cwd, home }); assert.equal(result.status, 0, result.stderr);
  const committed = git(cwd, ['show', '--format=', '--name-only', 'HEAD']).stdout;
  assert.match(committed, /AGENTS.md/); assert.doesNotMatch(committed, /unrelated|docs\/|\.geppetto\/install\.json/);
  assert.equal(git(cwd, ['check-ignore', '.geppetto/install.json']).status, 0);
  assert.equal(git(cwd, ['diff', '--cached', '--name-only']).stdout.trim(), 'unrelated.txt');
  assert.equal(get(cwd, 'README.md'), 'Original project');
});

test('plugin reconciliation removes owned duplicate skills, retains foreign skills and protects local changes', t => {
  const cwd = fixture(t), home = fixture(t); const { install } = source(t); const args = ['--target', 'codex', '--project', cwd];
  let result = invoke(install, args, { cwd, home }); assert.equal(result.status, 0, result.stderr);
  put(cwd, '.agents/skills/foreign/SKILL.md', 'Keep');
  put(cwd, '.agents/skills/geppetto-example/SKILL.md', 'Local change');
  result = invoke(install, [...args, '--plugin-hooks'], { cwd, home }); assert.equal(result.status, 1); assert.match(result.stderr, /Local edits/);
  put(cwd, '.agents/skills/geppetto-example/SKILL.md', '---\nname: geppetto-example\ndescription: Example\n---\nOriginal');
  result = invoke(install, [...args, '--plugin-hooks'], { cwd, home }); assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(resolve(cwd, '.agents/skills/geppetto-example/SKILL.md')), false);
  assert.equal(get(cwd, '.agents/skills/foreign/SKILL.md'), 'Keep');
  assert.equal(existsSync(resolve(cwd, '.agents/skills/geppetto-adopt/scripts/install.mjs')), false);
});

test('permission-blocked machine registration prints one retry command and keeps evidence outside project docs', t => {
  const cwd = fixture(t), home = fixture(t); const { root, install } = source(t);
  const path = 'skills/geppetto-adopt/scripts/machine.mjs';
  put(root, path, `export async function reconcileMachine() { throw Object.assign(new Error('fixture denied'), { code: 'EPERM' }); }\n`);
  const result = invoke(install, ['--target', 'codex', '--project', cwd, '--plugin-hooks'], { cwd, home });
  assert.equal(result.status, 1); assert.equal(result.stderr.trim().split('\n').length, 1);
  assert.match(result.stderr, /Machine registration blocked by permissions; run outside the sandbox:/); assert.match(result.stderr, /--target.*codex.*--project/);
  assert.equal(existsSync(resolve(cwd, 'docs')), false);
  assert.equal(existsSync(resolve(cwd, '.geppetto/machine.json')), false);
});

test('adoption instructions preserve consent, recap and same-session bootstrap while keeping routers generic', () => {
  const adopt = get(repo, 'skills/geppetto-adopt/SKILL.md'), instructions = get(repo, 'skills/geppetto-adopt/references/installation.md');
  assert.match(adopt, /installation request is the yes/i); assert.match(adopt, /install question.*does not know what Geppetto does/); assert.match(adopt, /same session/);
  assert.match(adopt, /Installed \| Reused from this machine \| Skipped and why \| How to change/);
  assert.match(instructions, /--begin/); assert.match(instructions, /--commit/); assert.match(instructions, /outside the project/);
  assert.doesNotMatch(get(repo, 'skills/geppetto-adopt/assets/templates/AGENTS.md'), /visible Windows windows/);
});

function source(t) {
  const root = fixture(t); cpSync(scripts, resolve(root, 'skills/geppetto-adopt/scripts'), { recursive: true });
  cpSync(resolve(repo, 'hooks'), resolve(root, 'hooks'), { recursive: true });
  put(root, 'package.json', { name: 'geppetto', version: '0.1.0' });
  put(root, 'skills/geppetto-adopt/SKILL.md', '---\nname: geppetto-adopt\ndescription: Adopt\n---\nAdopt');
  put(root, 'skills/geppetto-example/SKILL.md', '---\nname: geppetto-example\ndescription: Example\n---\nOriginal');
  cpSync(resolve(repo, 'skills/geppetto-adopt/assets/templates'), resolve(root, 'skills/geppetto-adopt/assets/templates'), { recursive: true });
  git(root, ['init', '-q']); git(root, ['config', 'user.name', 'Fixture']); git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'Package']);
  return { root, install: resolve(root, 'skills/geppetto-adopt/scripts/install.mjs') };
}

test('installation ignores local authorizations while preserving grants and existing ignore entries', t => {
  const cwd = fixture(t); const { install } = source(t); const args = ['--target', 'claude', '--project', cwd];
  assert.equal(git(cwd, ['init']).status, 0);
  const grant = '[fixture] provider=local budget_usd=0 per=1d scope="fixture" expires=never\n';
  const ignored = '/custom-local\n/authorizations\n!*\n';
  put(cwd, '.geppetto/authorizations', grant); put(cwd, '.geppetto/.gitignore', ignored);
  let r = invoke(install, [...args, '--dry-run'], { cwd }); assert.equal(r.status, 0, r.stderr);
  assert.equal(get(cwd, '.geppetto/.gitignore'), ignored);
  for (let i = 0; i < 2; i++) { r = invoke(install, args, { cwd }); assert.equal(r.status, 0, r.stderr); }
  assert.equal(get(cwd, '.geppetto/authorizations'), grant);
  assert.equal(get(cwd, '.geppetto/.gitignore'), `${ignored}/authorizations\n/install.json\n/turns.jsonl\n/reviews.jsonl\n/hook-state/\n/hook-events.jsonl\n`);
  assert.equal(git(cwd, ['check-ignore', '.geppetto/authorizations']).status, 0);
  assert.equal(git(cwd, ['check-ignore', '.geppetto/config.json']).status, 1);
});

test('installation ships the reusable Codex hook approval command and its resolver', t => {
  const cwd = fixture(t); const { install } = source(t);
  const r = invoke(install, ['--target', 'codex', '--project', cwd], { cwd });
  assert.equal(r.status, 0, r.stderr);
  for (const path of ['.agents/skills/geppetto-adopt/scripts/codex-hook-trust.mjs']) {
    const help = invoke(resolve(cwd, path), ['--help'], { cwd });
    assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /--approve/);
  }
});

test('reinstallation tolerates an absent machine-local grant previously recorded by adoption', t => {
  const cwd = fixture(t); const { install } = source(t); const args = ['--target', 'codex', '--project', cwd];
  put(cwd, '.geppetto/authorizations', '');
  let r = invoke(install, [...args, '--record-generated', '.geppetto/authorizations'], { cwd }); assert.equal(r.status, 0, r.stderr);
  unlinkSync(resolve(cwd, '.geppetto/authorizations'));
  for (const extra of [['--dry-run'], [], ['--dry-run']]) {
    r = invoke(install, [...args, ...extra], { cwd }); assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(resolve(cwd, '.geppetto/authorizations')), false);
  }
  const state = JSON.parse(get(cwd, '.geppetto/install.json')).installations.codex;
  assert.equal(state.files['.geppetto/authorizations'], undefined);
  assert.equal(state.generated.includes('.geppetto/authorizations'), false);
  r = invoke(install, [...args, '--record-generated', '.geppetto/authorizations'], { cwd }); assert.equal(r.status, 1);
});

test('dry run is read-only, installation uses skill scripts, update reconciles hashes, uninstall preserves foreign files', t => {
  const cwd = fixture(t), home = fixture(t); const { root, install } = source(t); const args = ['--target', 'codex', '--project', cwd];
  let r = invoke(install, [...args, '--dry-run'], { cwd }); assert.equal(r.status, 0, r.stderr); assert.equal(existsSync(resolve(cwd, '.geppetto')), false);
  r = invoke(install, args, { cwd }); assert.equal(r.status, 0, r.stderr); assert.match(get(cwd, '.agents/skills/geppetto-example/SKILL.md'), /Original$/);
  assert.equal(existsSync(resolve(cwd, '.geppetto/bin/pr-event.mjs')), false);
  const prompt = invoke(resolve(cwd, '.agents/skills/geppetto-adopt/scripts/hook.mjs'), [], { cwd, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'Review this feedback', cwd }) });
  assert.equal(prompt.status, 0, prompt.stderr); assert.deepEqual(JSON.parse(prompt.stdout), {});
  r = invoke(resolve(cwd, '.agents/skills/geppetto-adopt/scripts/gate-sections.mjs'), ['--pr', '-'], { cwd, input: '## Observability\nLogs' }); assert.equal(r.status, 0, r.stderr);
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

test('user install selects the user home and multiple targets retain shared skills until the last owner uninstalls', t => {
  const cwd = fixture(t); const home = fixture(t); const { root, install } = source(t);
  for (const target of ['codex', 'agents']) { const r = invoke(install, ['--target', target, '--user'], { cwd, home }); assert.equal(r.status, 0, r.stderr); }
  assert.equal(existsSync(resolve(cwd, '.agents')), false); assert.match(get(home, '.agents/skills/geppetto-example/SKILL.md'), /Original$/);
  put(root, 'skills/geppetto-adopt/scripts/gate-sections.mjs', `${get(root, 'skills/geppetto-adopt/scripts/gate-sections.mjs')}\n// Updated shared gate\n`);
  const update = invoke(install, ['--target', 'agents', '--user'], { cwd, home }); assert.equal(update.status, 0, update.stderr);
  assert.match(get(home, '.agents/skills/geppetto-adopt/scripts/gate-sections.mjs'), /Updated shared gate/);
  assert.equal(invoke(install, ['--target', 'codex', '--user', '--uninstall'], { cwd, home }).status, 0); assert.equal(existsSync(resolve(home, '.agents/skills/geppetto-adopt/scripts/gate-sections.mjs')), true);
  assert.equal(invoke(install, ['--target', 'agents', '--user', '--uninstall'], { cwd, home }).status, 0); assert.equal(existsSync(resolve(home, '.agents/skills/geppetto-adopt/scripts/gate-sections.mjs')), false);
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

test('installed skill installers resolve recorded source and fail safely without provenance', t => {
  const cwd = fixture(t); const { root, install } = source(t); const args = ['--target', 'codex', '--project', cwd];
  assert.equal(invoke(install, args, { cwd }).status, 0);
  const manifest = JSON.parse(get(cwd, '.geppetto/install.json'));
  assert.deepEqual(manifest.source, { path: root, version: '0.1.0' });
  for (const copy of ['.agents/skills/geppetto-adopt/scripts/install.mjs']) {
    const r = invoke(resolve(cwd, copy), [...args, '--dry-run'], { cwd });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /0 file changes/); assert.doesNotMatch(r.stdout, /remove /);
  }
  delete manifest.source; put(cwd, '.geppetto/install.json', manifest);
  const r = invoke(resolve(cwd, '.agents/skills/geppetto-adopt/scripts/install.mjs'), [...args, '--dry-run'], { cwd });
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
  args.push('--plugin-hooks');
  const generated = ['AGENTS.md', 'CLAUDE.md', '.geppetto/config.json', '.geppetto/authorizations', '.claude/settings.json', '.codex/hooks.json', '.github/workflows/pr-gate.yml'];
  for (const path of generated.filter(path => !path.endsWith('.yml'))) put(cwd, path, path === '.geppetto/config.json' ? '{}' : `Owned ${path}`);
  let r = invoke(install, [...args, '--record-generated', ...generated], { cwd }); assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(get(cwd, '.geppetto/install.json')).installations.codex;
  assert.deepEqual(state.generated, [...generated].sort()); for (const path of generated) assert.match(state.files[path], /^[a-f\d]{64}$/);
  r = invoke(install, [...args, '--dry-run'], { cwd }); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /0 file changes/);
  put(cwd, '.codex/hooks.json', 'Host edit'); r = invoke(install, [...args, '--uninstall'], { cwd }); assert.equal(r.status, 1); assert.match(r.stderr, /Local edits/);
  assert.equal(get(cwd, 'AGENTS.md'), 'Owned AGENTS.md'); put(cwd, '.codex/hooks.json', 'Owned .codex/hooks.json');
  r = invoke(install, [...args, '--uninstall'], { cwd }); assert.equal(r.status, 0, r.stderr); for (const path of generated) assert.equal(existsSync(resolve(cwd, path)), false);
});

for (const action of ['update', 'uninstall']) test(`${action} removes owned legacy bin scripts and preserves foreign files`, t => {
  const cwd = fixture(t), home = fixture(t); const { install } = source(t);
  const args = ['--target', 'codex', '--project', cwd, '--plugin-hooks'];
  assert.equal(invoke(install, args, { cwd, home }).status, 0);
  const legacy = '.geppetto/bin/pr-event.mjs', bytes = 'Legacy owned gate';
  put(cwd, legacy, bytes); put(cwd, '.geppetto/bin/foreign.mjs', 'Keep foreign');
  const state = JSON.parse(get(cwd, '.geppetto/install.json'));
  state.installations.codex.files[legacy] = createHash('sha256').update(bytes).digest('hex');
  put(cwd, '.geppetto/install.json', state);
  put(cwd, legacy, 'Local edits');
  let result = invoke(install, [...args, ...(action === 'uninstall' ? ['--uninstall'] : [])], { cwd, home });
  assert.equal(result.status, 1); assert.match(result.stderr, /Local edits/);
  put(cwd, legacy, bytes);
  result = invoke(install, [...args, ...(action === 'uninstall' ? ['--uninstall'] : []), '--dry-run'], { cwd, home });
  assert.equal(result.status, 0, result.stderr); assert.equal(get(cwd, legacy), bytes);
  result = invoke(install, [...args, ...(action === 'uninstall' ? ['--uninstall'] : [])], { cwd, home });
  assert.equal(result.status, 0, result.stderr); assert.equal(existsSync(resolve(cwd, legacy)), false);
  assert.equal(get(cwd, '.geppetto/bin/foreign.mjs'), 'Keep foreign');
});

test('fresh adoption pins the package gate in CI and rerun changes only its SHA', t => {
  const cwd = fixture(t), home = fixture(t); const { root, install } = source(t);
  const args = ['--target', 'codex', '--project', cwd, '--plugin-hooks'];
  let result = invoke(install, args, { cwd, home }); assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(resolve(cwd, '.geppetto/bin')), false);
  const workflow = get(cwd, '.github/workflows/pr-gate.yml');
  const initial = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  assert.ok(workflow.includes(`ref: ${initial}`)); assert.match(workflow, /repository: immagiov4\/Geppetto/);
  assert.doesNotMatch(workflow, /vars\.|\.geppetto\/bin|\{\{GEPPETTO_SHA\}\}/);
  put(root, 'revision.txt', 'Updated package'); git(root, ['add', '.']); git(root, ['commit', '-qm', 'Update package']);
  const next = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  result = invoke(install, [...args, '--dry-run'], { cwd, home }); assert.equal(result.status, 0, result.stderr); assert.equal(get(cwd, '.github/workflows/pr-gate.yml'), workflow);
  result = invoke(install, args, { cwd, home }); assert.equal(result.status, 0, result.stderr);
  assert.equal(get(cwd, '.github/workflows/pr-gate.yml'), workflow.replace(initial, next));
  put(cwd, '.github/workflows/pr-gate.yml', workflow + '# owner edit\n');
  result = invoke(install, args, { cwd, home }); assert.equal(result.status, 1); assert.match(result.stderr, /Local edits/);
});

test('a cached plugin needs an explicit immutable gate SHA and preserves it on repeat installation', t => {
  const cwd = fixture(t), home = fixture(t); const { root, install } = source(t);
  renameSync(resolve(root, '.git'), resolve(root, 'git-metadata'));
  const args = ['--target', 'codex', '--project', cwd, '--plugin-hooks'];
  for (const extra of [[], ['--gate-sha', 'main'], ['--gate-sha', 'a'.repeat(39)]]) {
    const result = invoke(install, [...args, ...extra], { cwd, home });
    assert.equal(result.status, 2); assert.match(result.stderr, /immutable|reviewed SHA/);
    assert.equal(existsSync(resolve(cwd, '.geppetto')), false);
  }
  const pinned = [...args, '--gate-sha', 'b'.repeat(40)];
  for (let repeat = 0; repeat < 2; repeat++) {
    const result = invoke(install, pinned, { cwd, home }); assert.equal(result.status, 0, result.stderr);
    assert.ok(get(cwd, '.github/workflows/pr-gate.yml').includes(`ref: ${'b'.repeat(40)}`));
    assert.equal(existsSync(resolve(cwd, '.geppetto/bin')), false);
  }
});

test('rerunning one target retires legacy bin scripts shared by multiple owned targets', t => {
  const cwd = fixture(t), home = fixture(t); const { install } = source(t);
  for (const target of ['claude', 'codex']) assert.equal(invoke(install, ['--target', target, '--project', cwd, '--plugin-hooks'], { cwd, home }).status, 0);
  const state = JSON.parse(get(cwd, '.geppetto/install.json')), path = '.geppetto/bin/common.mjs', bytes = 'Shared legacy script';
  put(cwd, path, bytes);
  for (const entry of Object.values(state.installations)) entry.files[path] = createHash('sha256').update(bytes).digest('hex');
  put(cwd, '.geppetto/install.json', state);
  const result = invoke(install, ['--target', 'codex', '--project', cwd, '--plugin-hooks'], { cwd, home }); assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(resolve(cwd, '.geppetto/bin')), false);
  for (const entry of Object.values(JSON.parse(get(cwd, '.geppetto/install.json')).installations)) assert.equal(entry.files[path], undefined);
});
