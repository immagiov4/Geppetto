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
