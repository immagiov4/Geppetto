import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, put, get, invoke, repo, scripts, git, config } from './helpers.mjs';

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
      const command = hooks[name][0].hooks[0].command;
      assert.match(command, /^node -e ".*"$/);
      const result = spawnSync(process.execPath, ['-e', command.slice('node -e "'.length, -1)], { cwd: resolve(cwd, 'apps/backend'), input: JSON.stringify({ hook_event_name: name, session_id: 'template', cwd: resolve(cwd, 'apps/backend'), tool_name: 'Read', tool_input: {}, ...extra }), encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
    };
    assert.deepEqual(event('UserPromptSubmit'), {});
    const routing = event('UserPromptSubmit', { prompt: 'Change the required result and review this feedback' });
    assert.match(routing.hookSpecificOutput.additionalContext, /\$requirements-blast-radius/);
    assert.match(routing.hookSpecificOutput.additionalContext, /\$receive-work-feedback/);
    assert.equal(routing.hookSpecificOutput.additionalContext.split('\n').length, 2);
    assert.deepEqual(event('PreToolUse'), {});
    const learning = event('PostToolUse');
    assert.deepEqual(Object.keys(learning), ['hookSpecificOutput']);
    assert.equal(learning.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(learning.hookSpecificOutput.additionalContext, /signal\.mjs/);
    assert.deepEqual(event('PostToolUse'), {});
    assert.equal(hooks.PostToolUse[0].hooks[0].async, undefined, 'context must arrive before the next model request');
    assert.ok(hooks.Stop.flatMap(group => group.hooks).some(handler => handler.async && handler.command.includes('learn-runner.mjs')));
    assert.equal(JSON.parse(get(cwd, '.geppetto/hook-events.jsonl')).hook, 'learnNudge');
    const memory = fixture(t); git(memory, ['init', '-q']); put(memory, 'index.md', '| Bucket | Scope | Holds |\n|---|---|---|\n| preferences | global | Working preferences. |\n');
    put(cwd, '.geppetto/config.json', { ...config(), memory: { repo: 'https://example.invalid/memory', localPath: memory, buckets: [] } });
    assert.match(event('SessionStart').hookSpecificOutput.additionalContext, /preferences — Working preferences/);
    assert.match(hooks.UserPromptSubmit[0].hooks[1].command, /memory-hook\.mjs/);
    const selector = hooks.UserPromptSubmit.flatMap(group => group.hooks).find(handler => handler.command.includes('skill-hook.mjs'));
    assert.ok(selector);
    const selected = spawnSync(process.execPath, ['-e', selector.command.slice('node -e "'.length, -1)], { cwd: resolve(cwd, 'apps/backend'), input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd, prompt: ' ' }), encoding: 'utf8', windowsHide: true });
    assert.equal(selected.status, 0, selected.stderr); assert.deepEqual(JSON.parse(selected.stdout), {});
  }
});

test('the plugin hook entrypoint requests learning internally while preserving async ingestion', t => {
  const hooks = JSON.parse(get(repo, 'hooks/hooks.json')).hooks;
  const handler = hooks.PostToolUse[0].hooks[0];
  assert.equal(handler.async, undefined);
  assert.equal(handler.command, 'node "${CLAUDE_PLUGIN_ROOT}/skills/geppetto-adopt/scripts/hook.mjs"');
  assert.ok(hooks.Stop.flatMap(group => group.hooks).some(hook => hook.async && hook.command.includes('learn-runner.mjs')));
  const cwd = fixture(t); put(cwd, '.geppetto/config.json', { ...config(), hooks: { learnNudge: { minToolCalls: 1 } } });
  const send = name => invoke('hook.mjs', [], { cwd, input: JSON.stringify({ hook_event_name: name, session_id: 'plugin', cwd, tool_name: 'Read', tool_input: {} }) });
  assert.equal(send('PreToolUse').status, 0);
  const post = send('PostToolUse'); assert.equal(post.status, 0, post.stderr);
  assert.match(JSON.parse(post.stdout).hookSpecificOutput.additionalContext, /signal\.mjs/);
  assert.deepEqual(JSON.parse(send('Stop').stdout), {});
});

test('first-adoption CI selects only base scripts or a valid owner-pinned package and runs its gate', t => {
  const workflow = get(templates, 'ci/pr-gate.yml').replaceAll('\r\n', '\n'); assert.equal(get(repo, '.github/workflows/pr-gate.yml').replaceAll('\r\n', '\n'), workflow);
  const selection = workflow.match(/run: \|\n([\s\S]*?)      - name: Fetch owner-pinned bootstrap/)[1].split('\n').map(line => line.slice(10)).join('\n');
  const shell = process.platform === 'win32' ? resolve(git(repo, ['--exec-path']).stdout.trim(), '../../../bin/bash.exe') : 'bash';
  const cwd = fixture(t); const output = resolve(cwd, 'output').replaceAll('\\', '/');
  const choose = (repository = '', sha = '') => {
    put(cwd, 'output', '');
    return spawnSync(shell, ['-c', selection], { cwd, env: { ...process.env, GITHUB_OUTPUT: output, BOOTSTRAP_REPOSITORY: repository, BOOTSTRAP_SHA: sha }, encoding: 'utf8', windowsHide: true });
  };
  let r = choose(); assert.equal(r.status, 1); assert.match(r.stderr, /owner-set/);
  r = choose('owner/geppetto', 'main'); assert.equal(r.status, 1);
  r = choose('owner/geppetto', 'a'.repeat(40)); assert.equal(r.status, 0, r.stderr);
  assert.match(get(cwd, 'output'), /script=.geppetto-bootstrap\/skills\/geppetto-adopt\/scripts\/pr-event.mjs\nbootstrap=true/);
  cpSync(scripts, resolve(cwd, '.geppetto-bootstrap/skills/geppetto-adopt/scripts'), { recursive: true });
  put(cwd, 'event.json', { pull_request: { body: '## Observability\nLogs $(touch unsafe)' } });
  r = invoke(resolve(cwd, '.geppetto-bootstrap/skills/geppetto-adopt/scripts/pr-event.mjs'), ['--event', 'event.json'], { cwd }); assert.equal(r.status, 0, r.stderr);
  put(cwd, 'skills/geppetto-adopt/scripts/pr-event.mjs', 'trusted package'); r = choose(); assert.equal(r.status, 0, r.stderr); assert.match(get(cwd, 'output'), /script=skills\/geppetto-adopt/);
  put(cwd, '.geppetto/bin/pr-event.mjs', 'trusted installed'); r = choose(); assert.equal(r.status, 0, r.stderr); assert.match(get(cwd, 'output'), /^script=.geppetto\/bin\/pr-event.mjs\nbootstrap=false/);
  assert.doesNotMatch(workflow, /pull_request\.head|pull_request\.body|secrets\./);
});
