import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixture, put, invoke, repo, config, git } from './helpers.mjs';
import { defaultConfig, validateConfig } from '../skills/geppetto-adopt/scripts/common.mjs';
import { runLearning } from '../skills/geppetto-adopt/scripts/learn-runner.mjs';

test('config accepts foundation choices independently of principle packs', () => {
  assert.deepEqual(defaultConfig().foundations, { documentation: null, observability: null });
  const chosen = { ...config(), foundations: { documentation: 'Topic documents with an index.', observability: 'Rotating redacted traces.' }, pillars: { gates: 'installed' } };
  assert.equal(validateConfig(chosen, 'fixture.json'), chosen);
  assert.doesNotThrow(() => validateConfig({ ...config(), foundations: { documentation: null } }, 'fixture.json'));
  for (const foundations of [null, [], 'chosen', { documentation: false }, { observability: '' }, { unknown: 'choice' }]) assert.throws(() => validateConfig({ ...config(), foundations }, 'fixture.json'), /foundations/);
});

test('audit reports unset foundations and preserves a recorded choice', t => {
  const root = fixture(t), home = fixture(t);
  let result = invoke('audit.mjs', ['--json'], { cwd: root, home });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).foundations.unset, ['documentation', 'observability']);
  assert.match(invoke('audit.mjs', [], { cwd: root, home }).stdout, /Unset foundations: documentation, observability/);
  put(root, '.geppetto/config.json', { ...config(), foundations: { documentation: 'Follow the author’s topic structure.' } });
  result = invoke('audit.mjs', ['--json'], { cwd: root, home });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).foundations.documentation, 'Follow the author’s topic structure.');
  assert.deepEqual(JSON.parse(result.stdout).foundations.unset, ['observability']);
});

test('installation recap surfaces unset foundations', t => {
  const root = fixture(t), home = fixture(t);
  const result = invoke('install.mjs', ['--target', 'codex', '--project', root, '--plugin-hooks', '--gate-sha', 'a'.repeat(40)], { cwd: root, home });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Unset foundations: documentation, observability/);
});

test('the bounded learner receives recorded foundation choices without needing configuration file access', async t => {
  const root = fixture(t), home = fixture(t);
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) git(root, args);
  put(root, 'README.md', '# Owner\n'); git(root, ['add', '.']); git(root, ['commit', '-qm', 'baseline']);
  put(root, '.geppetto/config.json', { foundations: { documentation: 'Coherent topic pages with an index.', observability: 'Sampled rotating traces.' } });
  put(root, '.geppetto/signals.jsonl', JSON.stringify({ id: 'foundations', key: 'foundations', session: 'fixture', source: 'user', category: 'workflow', status: 'open', text: 'Follow the agreed owner.' }) + '\n');
  await runLearning(root, { home, execute: async ({ prompt }) => {
    assert.match(prompt, /Resolved project foundations:.*Coherent topic pages with an index.*Sampled rotating traces/);
    return { decision: 'no_change', owner: 'README.md', reason: 'The agreed owner already covers this case.' };
  } });
});

test('foundation instructions fit within each skill’s existing word count', () => {
  for (const [name, maximum] of [['geppetto-spec', 396], ['geppetto-living-docs', 267], ['geppetto-x-ray', 520]]) {
    const text = readFileSync(resolve(repo, 'skills', name, 'SKILL.md'), 'utf8');
    assert.ok(text.trim().split(/\s+/).length <= maximum, name);
  }
});

import { handleEvent } from '../skills/geppetto-adopt/scripts/hook.mjs';
test('increment 16 reaches foundation decisions before the first documentation or diagnostic edit', async t => {
  const root = fixture(t), home = fixture(t);
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) git(root, args);
  put(root, 'README.md', '# Project'); put(root, '.geppetto/config.json', config()); git(root, ['add', '.']); git(root, ['commit', '-qm', 'baseline']);
  const event = { cwd: root, session_id: 'increment16', turn_id: '16' };
  const start = await handleEvent({ ...event, hook_event_name: 'SessionStart' }, { home });
  assert.match(start.hookSpecificOutput.additionalContext, /foundations.*documentation.*observability/);
  await handleEvent({ ...event, hook_event_name: 'UserPromptSubmit', prompt: 'Voglio capire come mantenere questo progetto: scrivi la documentazione dell’architettura, dei dati e delle autorizzazioni. Aggiungi una diagnostica utile per capire perché un caricamento o una riproduzione falliscono, senza esporre password o collegamenti privati.' }, { home });
  const edit = await handleEvent({ ...event, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'docs/architecture.md', content: '# Architecture' } }, { home });
  assert.match(edit.hookSpecificOutput.permissionDecisionReason, /foundations.*documentation.*observability/);
});
