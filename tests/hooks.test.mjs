import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, put, invoke } from './helpers.mjs';
import { handleEvent } from '../skills/geppetto-adopt/scripts/hook.mjs';
import { run } from '../skills/geppetto-adopt/scripts/common.mjs';

const hook = (cwd, tool_name, tool_input) => invoke('hook.mjs', [], { cwd, input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd, tool_name, tool_input }) });
test('PR-creation feedback runs gate-sections over literal bodies and body files without executing commands', t => {
  const cwd = fixture(t); put(cwd, 'body.md', '## Observability\nLogs');
  let r = hook(cwd, 'Bash', { command: 'gh pr create --body-file body.md' }); assert.equal(r.status, 0, r.stderr); assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /sections pass/);
  r = hook(cwd, 'Bash', { command: "gh pr create --body '## Summary'" }); assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /Missing section: Observability/);
  r = hook(cwd, 'Bash', { command: "gh pr create --body '## Observability\n$(touch owned)'" }); assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /sections pass/);
  r = hook(cwd, 'Bash', { command: 'gh pr create --fill' }); assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /provide --body-file/);
  r = hook(cwd, 'Bash', { command: "cd . && gh pr create --body='## Observability\nLogs'" }); assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /sections pass/);
});

test('pre-push reports unavailable PR information as advisory feedback', t => {
  const cwd = fixture(t); const r = hook(cwd, 'Bash', { command: 'git push origin main' }); assert.equal(r.status, 0, r.stderr); assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /current PR body is unavailable/);
});

test('pre-push fetches the current PR and passes its body through the real section gate', async t => {
  const cwd = fixture(t);
  for (const [body, expected] of [['## Summary\nChange', /Missing section: Observability/], ['## Observability\nFailures are logged.', /sections pass/]]) {
    const calls = [];
    const runCommand = (command, args, options) => {
      if (command === 'gh') { calls.push(args); return { status: 0, stdout: JSON.stringify({ body }) }; }
      return run(command, args, options);
    };
    const result = await handleEvent({ tool_name: 'Bash', tool_input: { command: 'git push' }, cwd }, { runCommand });
    assert.match(result.hookSpecificOutput.additionalContext, expected); assert.deepEqual(calls, [['pr', 'view', '--json', 'body']]);
  }
});

test('CI event adapter rechecks edited PR bodies as inert stdin and rejects missing or empty bodies', t => {
  const cwd = fixture(t); put(cwd, 'event.json', { action: 'edited', pull_request: { body: '## Observability\n${{ secrets.TOKEN }} $(touch owned)' } });
  let r = invoke('pr-event.mjs', ['--event', 'event.json'], { cwd }); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Sections OK/);
  put(cwd, 'event.json', { action: 'edited', pull_request: { body: null } }); r = invoke('pr-event.mjs', ['--event', 'event.json'], { cwd }); assert.equal(r.status, 1); assert.match(r.stderr, /Missing section/);
  put(cwd, 'event.json', {}); assert.equal(invoke('pr-event.mjs', ['--event', 'event.json'], { cwd }).status, 1);
  assert.equal(invoke('pr-event.mjs', [], { cwd, env: { GITHUB_EVENT_PATH: '' } }).status, 2);
});
