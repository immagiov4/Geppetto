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

test('PR workflow reacts to body edits and runs the trusted base gate without interpolating PR prose', () => {
  const workflow = readFileSync(resolve(repo, '.github/workflows/pr-gate.yml'), 'utf8');
  assert.match(workflow, /types: \[opened, edited, synchronize, reopened\]/); assert.match(workflow, /workflow_call:/); assert.match(workflow, /ref: \$\{\{ github.event.pull_request.base.sha \}\}/); assert.match(workflow, /script=\.geppetto\/bin\/pr-event.mjs/); assert.doesNotMatch(workflow, /\$\{\{[^}]*\.body/);
});
