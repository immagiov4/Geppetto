import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fixture, put, invoke } from './helpers.mjs';

test('install question and recap cover every capability choice', t => {
  const instructions = readFileSync('skills/geppetto-adopt/references/installation.md', 'utf8');
  const question = instructions.split('## Capability question')[1].split('## Memory')[0];
  for (const name of ['**Memory**', '**Checks while working**', 'go to OpenRouter, private projects included', '**Learning from your corrections**', '**Weekly upkeep**', '**GitHub check**', '--share-source yes|no', 'maintenance.enabled', 'ci.enabled']) assert.ok(question.includes(name), name);
  const cwd = fixture(t);
  put(cwd, '.geppetto/config.json', { memory: { choice: 'none' }, screen: { shareSource: true }, maintenance: { enabled: false }, ci: { enabled: false }, hooks: { signalLearning: { enabled: false } } });
  const result = invoke('install.mjs', ['--target', 'codex', '--project', cwd, '--plugin-hooks'], { cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(`${cwd}/.github/workflows/pr-gate.yml`), false);
  const machine = JSON.parse(readFileSync(`${cwd}/.geppetto/machine.json`, 'utf8'));
  assert.equal(machine.jobs['curate-skills'], undefined);
  assert.equal(machine.jobs['maintain-memory'], undefined);
  for (const name of ['Memory:', 'hooks=', 'screen.shareSource=true', 'learner=', 'review=', 'maintenance.enabled=false', 'ci.enabled=false', 'OPENROUTER_API_KEY']) assert.ok(result.stdout.includes(name), result.stdout);
});

test('declined answers turn off what an earlier installation started', async t => {
  const { reconcileMachine } = await import('../skills/geppetto-adopt/scripts/machine.mjs');
  const { handleEvent } = await import('../skills/geppetto-adopt/scripts/hook.mjs');
  const { validateConfig } = await import('../skills/geppetto-adopt/scripts/common.mjs');
  const { config, git } = await import('./helpers.mjs');
  const registration = name => ({ scheduler: 'fixture', id: name, cadence: 'weekly', nextRun: '2026-11-02T09:00:00', disable: `fixture disable ${name}` });
  const jobs = Object.fromEntries(['curate-skills', 'maintain-memory'].map(name => [name, registration(name)]));
  const home = fixture(t), project = fixture(t), stopped = [];
  put(project, '.geppetto/config.json', { ...config(), memory: { choice: 'none' } });
  const options = { home, pluginHooks: true, jobs, scheduler: async name => registration(name), unscheduler: async name => { stopped.push(name); return true; } };
  assert.equal((await reconcileMachine(project, 'codex', { path: process.cwd() }, options)).jobs['curate-skills'].status, 'scheduled');
  put(project, '.geppetto/config.json', { ...config(), memory: { choice: 'none' }, maintenance: { enabled: false } });
  const machine = await reconcileMachine(project, 'codex', { path: process.cwd() }, { ...options, jobs: {} });
  assert.deepEqual(stopped.sort(), ['curate-skills', 'maintain-memory']);
  assert.equal(machine.jobs['curate-skills'].status, 'disabled');

  const cwd = fixture(t);
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) git(cwd, args);
  put(cwd, 'README.md', '# Fixture'); put(cwd, '.geppetto/config.json', { ...config(), memory: { choice: 'none' }, hooks: { reviewGate: { enabled: false, benchmark: null }, learnNudge: { enabled: false }, signalLearning: { enabled: false } } });
  git(cwd, ['add', '.']); git(cwd, ['commit', '-qm', 'baseline']);
  const send = (kind, extra = {}) => handleEvent({ cwd, session_id: 's', turn_id: 't', hook_event_name: kind, ...extra });
  await send('UserPromptSubmit');
  assert.deepEqual(await send('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'README.md' } }), {});

  for (const [section, value] of [['ci', { enabled: 'false' }], ['maintenance', { enabled: 'false' }], ['screen', { shareSource: 'yes' }]]) assert.throws(() => validateConfig({ ...config(), [section]: value }, 'fixture.json'), new RegExp(section));
});
