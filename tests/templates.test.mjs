import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, put, get, invoke, repo, scripts, git, config } from './helpers.mjs';

const templates = resolve(repo, 'skills/geppetto-adopt/assets/templates');
test('both shipped hook fragments execute from nested directories, preserve feedback and deliver one Stop reminder', t => {
  for (const path of ['hooks/claude/settings.json', 'hooks/codex/.codex/hooks.json']) {
    const cwd = fixture(t); cpSync(scripts, resolve(cwd, '.geppetto/bin'), { recursive: true });
    mkdirSync(resolve(cwd, 'apps/backend'), { recursive: true });
    put(cwd, '.geppetto/config.json', { ...config(), hooks: { learnNudge: { enabled: true, benchmark: null, minToolCalls: 1, minDurationMs: 300000 } } });
    const hooks = JSON.parse(get(templates, path)).hooks;
    const event = name => {
      const command = hooks[name][0].hooks[0].command;
      assert.match(command, /^node -e ".*"$/);
      const result = spawnSync(process.execPath, ['-e', command.slice('node -e "'.length, -1)], { cwd: resolve(cwd, 'apps/backend'), input: JSON.stringify({ hook_event_name: name, session_id: 'template', cwd: resolve(cwd, 'apps/backend'), tool_name: 'Write', tool_input: { file_path: '.geppetto/authorizations' } }), encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
    };
    assert.deepEqual(event('UserPromptSubmit'), {});
    assert.equal(event('PreToolUse').hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(event('Stop').decision, 'block'); assert.deepEqual(event('Stop'), {});
    assert.equal(JSON.parse(get(cwd, '.geppetto/hook-events.jsonl')).hook, 'learnNudge');
    const memory = fixture(t); git(memory, ['init', '-q']); put(memory, 'index.md', '| Bucket | Scope | Holds |\n|---|---|---|\n| preferences | global | Working preferences. |\n');
    put(cwd, '.geppetto/config.json', { ...config(), memory: { repo: 'https://example.invalid/memory', localPath: memory, buckets: [] } });
    assert.match(event('SessionStart').hookSpecificOutput.additionalContext, /preferences — Working preferences/);
    assert.match(hooks.UserPromptSubmit[0].hooks[1].command, /memory-hook\.mjs/);
  }
});

test('first-adoption CI selects only base scripts or a valid owner-pinned package and runs its gate', t => {
  const workflow = get(templates, 'ci/pr-gate.yml'); assert.equal(get(repo, '.github/workflows/pr-gate.yml'), workflow);
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
