import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { repo, fixture, invoke } from './helpers.mjs';

const read = path => JSON.parse(readFileSync(resolve(repo, path), 'utf8'));
test('both catalogs locate the same plugin and Codex component paths resolve from the package root', () => {
  const claude = read('.claude-plugin/plugin.json'); const codex = read('.codex-plugin/plugin.json');
  const ccatalog = read('.claude-plugin/marketplace.json'); const catalog = read('.agents/plugins/marketplace.json');
  assert.equal(claude.name, codex.name); assert.equal(claude.version, codex.version); assert.equal(read('package.json').version, claude.version);
  assert.equal(ccatalog.plugins[0].name, claude.name); assert.equal(resolve(repo, ccatalog.plugins[0].source), repo);
  assert.equal(catalog.plugins[0].name, codex.name); assert.equal(catalog.plugins[0].source.source, 'local'); assert.equal(resolve(repo, catalog.plugins[0].source.path), repo);
  assert.deepEqual(catalog.plugins[0].policy, { installation: 'AVAILABLE', authentication: 'ON_INSTALL' });
  for (const path of [codex.skills, codex.hooks]) { assert.match(path, /^\.\//); assert.equal(existsSync(resolve(repo, path)), true); }
  assert.equal(codex.interface.category, 'Productivity');
});

test('declared plugin hook launches its shipped script with a real event', t => {
  const cwd = fixture(t); const hooks = read('hooks/hooks.json'); const handler = hooks.hooks.PreToolUse[0];
  assert.equal(new RegExp(handler.matcher).test('apply_patch'), true); assert.equal(new RegExp(handler.matcher).test('Bash'), true);
  const command = handler.hooks[0].command.replace('${CLAUDE_PLUGIN_ROOT}', repo);
  const match = command.match(/^node "([^"]+)"$/); assert.ok(match, 'Hook command uses a quoted script path');
  const r = invoke(match[1], [], { cwd, input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '.geppetto/authorizations' }, cwd, hook_event_name: 'PreToolUse' }) });
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('plugin UserPromptSubmit delivers both reminders without a standalone hook or project configuration', t => {
  const cwd = fixture(t); const handler = read('hooks/hooks.json').hooks.UserPromptSubmit[0].hooks[0];
  const command = handler.command.replace('${CLAUDE_PLUGIN_ROOT}', repo);
  const match = command.match(/^node "([^"]+)"$/); assert.ok(match);
  const event = { hook_event_name: 'UserPromptSubmit', session_id: 'plugin-only', cwd, prompt: 'Revise the result using this feedback' };
  const result = invoke(match[1], [], { cwd, input: JSON.stringify(event) });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout); assert.deepEqual(Object.keys(output), ['hookSpecificOutput']);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const lines = output.hookSpecificOutput.additionalContext.split('\n'); assert.equal(lines.length, 2);
  assert.match(lines[0], /\$requirements-blast-radius/); assert.match(lines[1], /\$receive-work-feedback/);
  const blank = invoke(match[1], [], { cwd, input: JSON.stringify({ ...event, prompt: ' ' }) });
  assert.equal(blank.status, 0, blank.stderr); assert.deepEqual(JSON.parse(blank.stdout), {});
  const child = invoke(match[1], [], { cwd, input: JSON.stringify(event), env: { GEPPETTO_LEARNING_CHILD: '1' } });
  assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), {});
});

test('PR workflow reacts to body edits and runs the trusted base gate without interpolating PR prose', () => {
  const workflow = readFileSync(resolve(repo, '.github/workflows/pr-gate.yml'), 'utf8');
  assert.match(workflow, /types: \[opened, edited, synchronize, reopened\]/); assert.match(workflow, /workflow_call:/); assert.match(workflow, /ref: \$\{\{ github.event.pull_request.base.sha \}\}/); assert.match(workflow, /script=\.geppetto\/bin\/pr-event.mjs/); assert.doesNotMatch(workflow, /\$\{\{[^}]*\.body/);
});
