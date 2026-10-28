import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fixture, put, get, invoke, repo, config } from './helpers.mjs';
import { filesUnder, defaultConfig } from '../skills/geppetto-adopt/scripts/common.mjs';

test('native skill discovery installs and runs with stale selector configuration', t => {
  const cwd = fixture(t), home = fixture(t);
  const stale = { ...config(), hooks: { skillSelector: { enabled: true, model: '', threshold: 'obsolete' } } };
  put(cwd, '.geppetto/config.json', stale); put(cwd, 'AGENTS.md', '# Project');
  put(home, '.geppetto/config.json', { hooks: { skillSelector: 'obsolete' } });
  let result = invoke('install.mjs', ['--target', 'codex', '--project', cwd, '--plugin-hooks'], { cwd, home });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(get(cwd, '.geppetto/config.json')).hooks, stale.hooks);
  result = invoke('audit.mjs', ['--project', cwd, '--json', '--verify'], { cwd, home });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal('skillSelector' in JSON.parse(result.stdout), false);
  assert.equal('skillSelector' in defaultConfig().hooks, false);
  for (const path of ['hooks/hooks.json', 'skills/geppetto-adopt/assets/templates/hooks/claude/settings.json', 'skills/geppetto-adopt/assets/templates/hooks/codex/.codex/hooks.json']) {
    const handlers = JSON.parse(get(repo, path)).hooks.UserPromptSubmit.flatMap(group => group.hooks);
    assert.equal(handlers.length, 1);
    const match = handlers[0].command.replaceAll('${CLAUDE_PLUGIN_ROOT}', repo).match(/^node "([^"]+)"$/); assert.ok(match);
    const result = invoke(match[1], [], { cwd, home, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd, prompt: 'Revise this requirement using the feedback' }) });
    assert.equal(result.status, 0, result.stderr);
    const lines = JSON.parse(result.stdout).hookSpecificOutput.additionalContext.split('\n');
    assert.equal(lines.length, 3); assert.match(lines[0], /\$requirements-blast-radius/); assert.match(lines[1], /\$receive-work-feedback/); assert.match(lines[2], /\$geppetto-learn/);
  }
});

test('the shipped package uses native discovery without selector remnants', () => {
  const paths = ['skills', 'hooks', 'docs', '.claude-plugin', '.codex-plugin', '.agents/plugins'].flatMap(path => filesUnder(resolve(repo, path)));
  paths.push(...['README.md', 'AGENTS.md', '.geppetto/config.json'].map(path => resolve(repo, path)));
  for (const path of paths.filter(path => !path.endsWith('CHANGELOG.md'))) assert.doesNotMatch(readFileSync(path, 'utf8'), /skill[ -]?(?:selector|catalog|provider|batches|hook)|geppetto-authorize|authz\.mjs/i, path);
});

test('a Codex update reconciles Claude shared hooks and preserves foreign handlers', t => {
  const cwd = fixture(t), home = fixture(t);
  for (const target of ['claude', 'codex']) {
    const result = invoke('install.mjs', ['--target', target, '--project', cwd], { cwd, home });
    assert.equal(result.status, 0, result.stderr);
  }
  const settings = JSON.parse(get(home, '.claude/settings.json'));
  const obsolete = 'node "legacy/geppetto-adopt/scripts/skill-hook.mjs"';
  settings.hooks.UserPromptSubmit[0].hooks.push({ type: 'command', command: obsolete }, { type: 'command', command: 'keep-foreign-handler' });
  put(home, '.claude/settings.json', settings);
  const machine = JSON.parse(get(home, '.geppetto/machine.json'));
  machine.hooks.claude.commands.push(obsolete); put(home, '.geppetto/machine.json', machine);
  const result = invoke('install.mjs', ['--target', 'codex', '--project', cwd], { cwd, home });
  assert.equal(result.status, 0, result.stderr);
  const commands = JSON.parse(get(home, '.claude/settings.json')).hooks.UserPromptSubmit.flatMap(group => group.hooks.map(hook => hook.command));
  assert.equal(commands.includes(obsolete), false); assert.equal(commands.includes('keep-foreign-handler'), true);
  assert.equal(commands.filter(command => command.includes('geppetto-adopt')).length, 1);
});
