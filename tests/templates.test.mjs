import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, put, get, invoke, repo, git, config } from './helpers.mjs';

const templates = resolve(repo, 'skills/geppetto-adopt/assets/templates');
test('both shipped hook fragments deliver internal context from nested directories and leave Stop for background learning', t => {
  for (const path of ['hooks/claude/settings.json', 'hooks/codex/.codex/hooks.json']) {
    const cwd = fixture(t);
    const installed = invoke('install.mjs', ['--target', path.includes('/claude/') ? 'claude' : 'codex', '--project', cwd], { cwd });
    assert.equal(installed.status, 0, installed.stderr);
    mkdirSync(resolve(cwd, 'apps/backend'), { recursive: true });
    put(cwd, '.geppetto/config.json', { ...config(), hooks: { learnNudge: { enabled: true, benchmark: null, minToolCalls: 1, minDurationMs: 300000 } } });
    const hooks = JSON.parse(get(templates, path)).hooks;
    const event = (name, extra = {}) => {
      const command = hooks[name][0].hooks[0].command.replaceAll('${CLAUDE_PLUGIN_ROOT}', repo);
      assert.match(command, /^node ".*"$/);
      const result = spawnSync(process.execPath, [command.slice('node "'.length, -1)], { cwd: resolve(cwd, 'apps/backend'), input: JSON.stringify({ hook_event_name: name, session_id: 'template', cwd: resolve(cwd, 'apps/backend'), tool_name: 'Read', tool_input: {}, ...extra }), encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
    };
    assert.deepEqual(event('UserPromptSubmit'), {});
    const routing = event('UserPromptSubmit', { prompt: 'Change the required result and review this feedback' });
    assert.deepEqual(routing, {});
    assert.deepEqual(event('PreToolUse'), {});
    const learning = event('PostToolUse');
    assert.deepEqual(Object.keys(learning), ['hookSpecificOutput']);
    assert.equal(learning.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(learning.hookSpecificOutput.additionalContext, /signal\.mjs/);
    assert.deepEqual(event('PostToolUse'), {});
    assert.equal(hooks.PostToolUse[0].hooks[0].async, undefined, 'context must arrive before the next model request');
    assert.equal(hooks.Stop.flatMap(group => group.hooks).length, 1, 'the shared Stop dispatch starts the existing runner');
    assert.equal(JSON.parse(get(cwd, '.geppetto/hook-events.jsonl')).hook, 'learnNudge');
    const memory = fixture(t); git(memory, ['init', '-q']); put(memory, 'index.md', '| Bucket | Scope | Holds |\n|---|---|---|\n| preferences | global | Working preferences. |\n');
    put(cwd, '.geppetto/config.json', { ...config(), memory: { repo: 'https://example.invalid/memory', localPath: memory, buckets: [] } });
    assert.match(event('SessionStart').hookSpecificOutput.additionalContext, /preferences — Working preferences/);
    assert.equal(hooks.UserPromptSubmit.flatMap(group => group.hooks).some(handler => handler.command.includes('memory-hook.mjs')), false);
  }
});

test('the plugin hook entrypoint requests learning internally and owns the single Stop dispatch', t => {
  const hooks = JSON.parse(get(repo, 'hooks/hooks.json')).hooks;
  const handler = hooks.PostToolUse[0].hooks[0];
  assert.equal(handler.async, undefined);
  assert.equal(handler.command, 'node "${CLAUDE_PLUGIN_ROOT}/skills/geppetto-adopt/scripts/hook.mjs"');
  assert.equal(hooks.Stop.flatMap(group => group.hooks).length, 1);
  const cwd = fixture(t); put(cwd, '.geppetto/config.json', { ...config(), hooks: { learnNudge: { minToolCalls: 1 } } });
  const send = name => invoke('hook.mjs', [], { cwd, input: JSON.stringify({ hook_event_name: name, session_id: 'plugin', cwd, tool_name: 'Read', tool_input: {} }) });
  assert.equal(send('PreToolUse').status, 0);
  const post = send('PostToolUse'); assert.equal(post.status, 0, post.stderr);
  assert.match(JSON.parse(post.stdout).hookSpecificOutput.additionalContext, /signal\.mjs/);
  assert.deepEqual(JSON.parse(send('Stop').stdout), {});
});

test('generated CI runs only the pinned package gate against base configuration without vendored scripts', t => {
  const cwd = fixture(t), home = fixture(t), workspace = fixture(t);
  const installed = invoke('install.mjs', ['--target', 'codex', '--project', cwd, '--plugin-hooks'], { cwd, home });
  assert.equal(installed.status, 0, installed.stderr);
  const workflow = get(cwd, '.github/workflows/pr-gate.yml').replaceAll('\r\n', '\n');
  const template = get(templates, 'ci/pr-gate.yml').replaceAll('\r\n', '\n');
  assert.equal(workflow, template.replaceAll('{{GEPPETTO_SHA}}', git(repo, ['rev-parse', 'HEAD']).stdout.trim()));
  cpSync(cwd, resolve(workspace, 'project'), { recursive: true });
  const pinned = git(repo, ['rev-parse', 'HEAD']).stdout.trim();
  assert.equal(git(workspace, ['clone', '--quiet', '--shared', '--no-checkout', repo, 'geppetto']).status, 0);
  assert.equal(git(resolve(workspace, 'geppetto'), ['checkout', '--quiet', '--detach', pinned]).status, 0);
  assert.equal(git(resolve(workspace, 'geppetto'), ['rev-parse', 'HEAD']).stdout.trim(), pinned);
  const project = resolve(workspace, 'project');
  put(project, '.geppetto/config.json', { ...config(), sections: { ...config().sections, pr: ['Base contract'] } });
  put(project, 'event.json', { pull_request: { body: '## Observability\nInsufficient for base' } });
  const command = workflow.match(/        run: node (.+)\n/)[1];
  let result = invoke(resolve(project, command), [], { cwd: project, env: { GITHUB_EVENT_PATH: resolve(project, 'event.json') } });
  assert.equal(result.status, 1); assert.match(result.stderr, /Base contract/);
  put(project, 'event.json', { pull_request: { body: '## Base contract\nLogs $(touch unsafe)' } });
  result = invoke(resolve(project, command), [], { cwd: project, env: { GITHUB_EVENT_PATH: resolve(project, 'event.json') } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(resolve(project, 'unsafe')), false);
  assert.equal(existsSync(resolve(project, '.geppetto/bin')), false);
  assert.doesNotMatch(workflow, /vars\.|pull_request\.head|pull_request\.body|secrets\./);
  for (const [, sha] of workflow.matchAll(/uses: [^@]+@([^\s]+)/g)) assert.match(sha, /^[a-f\d]{40}$/);
});

test('CI trusts the base workflow and checks changed documents using the trusted event script', () => {
  const workflow = get(templates, 'ci/pr-gate.yml').replaceAll('\r\n', '\n');
  assert.match(workflow, /\n  pull_request_target:\n/);
  assert.doesNotMatch(workflow, /\n  pull_request:\n/);
  assert.match(workflow, /if: github.event_name == 'pull_request_target'/);
  assert.match(workflow, /ref: \$\{\{ github.event.pull_request.base.sha \}\}/);
  assert.match(workflow, /pull-requests: read/);
  assert.match(workflow, /run: node \.\.\/geppetto\/skills\/geppetto-adopt\/scripts\/pr-event\.mjs --docs/);
  assert.doesNotMatch(workflow, /pull_request\.head|pull_request\.body/);
});
