import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, put, get, git, config, invoke } from './helpers.mjs';
import { handleEvent } from '../skills/geppetto-adopt/scripts/hook.mjs';

test('every long turn receives internal learning context after a tool and Stop stays silent', async t => {
  const cwd = fixture(t); git(cwd, ['init', '-q']);
  put(cwd, '.geppetto/config.json', { ...config(), hooks: { learnNudge: { enabled: true, benchmark: null, minToolCalls: 2, minDurationMs: 1000 } } });
  const send = (name, session, now, extra = {}) => handleEvent({ hook_event_name: name, session_id: session, cwd, tool_name: 'Read', tool_input: { path: 'notes' }, ...extra }, { now: () => now });
  await send('UserPromptSubmit', 'first', 0); await send('PreToolUse', 'first', 100);
  assert.deepEqual(await send('PostToolUse', 'first', 200), {});
  assert.deepEqual(await send('Stop', 'first', 200), {});
  await send('UserPromptSubmit', 'first', 300); await send('PreToolUse', 'first', 400);
  assert.deepEqual(await send('PostToolUse', 'first', 500), {});
  assert.deepEqual(await send('Stop', 'first', 500), {}, 'short turns do not accumulate into a long turn');
  await send('PreToolUse', 'first', 600); const nudge = await send('PostToolUse', 'first', 700);
  assert.deepEqual(Object.keys(nudge), ['hookSpecificOutput']);
  assert.equal(nudge.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(nudge.hookSpecificOutput.additionalContext, /recurring friction.*signal\.mjs/);
  assert.match(nudge.hookSpecificOutput.additionalContext, /reusable workflow.*verified fix.*user correction/);
  assert.match(nudge.hookSpecificOutput.additionalContext, /before.*final reply/i);
  assert.match(nudge.hookSpecificOutput.additionalContext, /lesson or decision rationale with no other owner.*bucket memory/);
  assert.deepEqual(await send('PostToolUse', 'first', 750), {}, 'only duplicate reminders in this turn are suppressed');
  assert.deepEqual(await send('Stop', 'first', 800), {});
  await send('UserPromptSubmit', 'first', 900); await send('PreToolUse', 'first', 1000); await send('PreToolUse', 'first', 1100);
  assert.ok((await send('PostToolUse', 'first', 1200)).hookSpecificOutput.additionalContext, 'a later long turn in the same session remains eligible');
  assert.deepEqual(await send('Stop', 'first', 1200), {});
  await send('UserPromptSubmit', 'second', 0); await send('PreToolUse', 'second', 5000);
  assert.deepEqual(await send('PostToolUse', 'second', 5500, { stop_hook_active: true }), {});
  assert.deepEqual(await send('Stop', 'second', 5500), {}, 'wall time starts at the first call');
  assert.ok((await send('PostToolUse', 'second', 6000)).hookSpecificOutput.additionalContext, 'one long command qualifies when it finishes');
  assert.deepEqual(await send('Stop', 'second', 7000), {});
  const logs = get(cwd, '.geppetto/hook-events.jsonl').trim().split('\n').map(JSON.parse);
  assert.equal(logs.length, 3); assert.equal(logs[0].toolCalls, 2); assert.equal(logs[0].elapsedMs, 300); assert.equal(logs[2].toolCalls, 1); assert.equal(logs[2].elapsedMs, 1000);
  assert.notEqual(logs[0].turn, logs[1].turn);
  assert.equal(logs[0].hook, 'learnNudge'); assert.equal(logs[0].modelCalls, 0); assert.equal(logs[0].costUsd, 0);
  assert.equal(logs[0].event, 'PostToolUse');
  assert.equal(git(cwd, ['check-ignore', '.geppetto/hook-events.jsonl']).status, 0);
});

test('native turn IDs remain eligible without prompt events and old session markers impose no limit', async t => {
  const cwd = fixture(t); put(cwd, '.geppetto/config.json', { ...config(), hooks: { learnNudge: { minToolCalls: 1 } } });
  const session_id = 'legacy'; const sessionHash = createHash('sha256').update(session_id).digest('hex');
  put(cwd, `.geppetto/hook-state/${sessionHash}/fired`, '');
  for (const turn_id of ['first', 'second']) {
    const event = { cwd, session_id, turn_id, tool_use_id: `call-${turn_id}`, tool_name: 'Read', tool_input: {} };
    await handleEvent({ ...event, hook_event_name: 'PreToolUse' });
    assert.ok((await handleEvent({ ...event, hook_event_name: 'PostToolUse' })).hookSpecificOutput.additionalContext);
    assert.deepEqual(await handleEvent({ ...event, hook_event_name: 'PostToolUse' }), {});
  }
  assert.deepEqual(get(cwd, '.geppetto/hook-events.jsonl').trim().split('\n').map(line => JSON.parse(line).turn), ['first', 'second']);
});

test('learning defaults remain enabled and parallel tool completions deliver only one internal reminder', async t => {
  const cwd = fixture(t); put(cwd, '.geppetto/config.json', config());
  const send = (name, extra = {}) => handleEvent({ hook_event_name: name, session_id: 'parallel', cwd, tool_name: 'Read', tool_input: {}, ...extra }, { now: () => 0 });
  await send('PreToolUse');
  const posts = await Promise.all([handleEvent({ hook_event_name: 'PostToolUse', session_id: 'parallel', cwd }, { now: () => 300000 }), handleEvent({ hook_event_name: 'PostToolUse', session_id: 'parallel', cwd }, { now: () => 300000 })]);
  assert.equal(posts.filter(r => r.hookSpecificOutput?.additionalContext).length, 1);
  const disabled = fixture(t); put(disabled, '.geppetto/config.json', { ...config(), hooks: { learnNudge: { enabled: false, benchmark: null } } });
  assert.deepEqual(await handleEvent({ hook_event_name: 'PreToolUse', session_id: 'off', cwd: disabled, tool_name: 'Read', tool_input: {} }), {});
  assert.deepEqual(await handleEvent({ hook_event_name: 'PostToolUse', session_id: 'off', cwd: disabled }), {});
  assert.equal(existsSync(resolve(disabled, '.geppetto/hook-state')), false);
});

test('a failed event log preserves the opportunity to deliver and measure the reminder on retry', async t => {
  const cwd = fixture(t); put(cwd, '.geppetto/config.json', { ...config(), hooks: { learnNudge: { enabled: true, benchmark: null, minToolCalls: 1, minDurationMs: 1000 } } });
  const event = { cwd, session_id: 'log-recovery', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} };
  await handleEvent(event); const log = resolve(cwd, '.geppetto/hook-events.jsonl'); mkdirSync(log);
  await assert.rejects(handleEvent({ ...event, hook_event_name: 'PostToolUse' }));
  rmdirSync(log);
  assert.ok((await handleEvent({ ...event, hook_event_name: 'PostToolUse' })).hookSpecificOutput.additionalContext);
  assert.equal(JSON.parse(get(cwd, '.geppetto/hook-events.jsonl')).hook, 'learnNudge');
});

test('internal learning preserves PR feedback', async t => {
  const cwd = fixture(t); put(cwd, '.geppetto/config.json', { ...config(), hooks: { learnNudge: { minToolCalls: 1 } } });
  const event = { cwd, session_id: 'policy', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '.geppetto/authorizations' } };
  const pr = { ...event, tool_name: 'Bash', tool_input: { command: 'gh pr create --fill' } };
  assert.match((await handleEvent(pr)).hookSpecificOutput.additionalContext, /provide --body-file/);
  const post = await handleEvent({ ...pr, hook_event_name: 'PostToolUse' });
  assert.equal(post.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(post.hookSpecificOutput.additionalContext, /signal\.mjs/);
  assert.deepEqual(await handleEvent({ ...pr, hook_event_name: 'Stop' }), {});
});

test('learning children and tool-free completions create no reminder or hook state', async t => {
  const cwd = fixture(t); put(cwd, '.geppetto/config.json', config());
  for (const name of ['PreToolUse', 'PostToolUse', 'Stop']) {
    const event = { cwd, session_id: 'child', hook_event_name: name, tool_name: 'Read', tool_input: {} };
    const result = invoke('hook.mjs', [], { cwd, input: JSON.stringify(event), env: { GEPPETTO_LEARNING_CHILD: '1' } });
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), {});
  }
  assert.deepEqual(await handleEvent({ cwd, session_id: 'no-tools', hook_event_name: 'Stop' }), {});
  assert.equal(existsSync(resolve(cwd, '.geppetto/hook-state')), false);
});

test('Stop supplies the reminder when the qualifying turn has no tool-completion event', async t => {
  const cwd = fixture(t); put(cwd, '.geppetto/config.json', { ...config(), hooks: { learnNudge: { minToolCalls: 1 } } });
  const event = { cwd, session_id: 'stop-fallback', tool_name: 'Read', tool_input: {} };
  await handleEvent({ ...event, hook_event_name: 'PreToolUse' });
  const result = await handleEvent({ ...event, hook_event_name: 'Stop' });
  assert.equal(result.hookSpecificOutput.hookEventName, 'Stop');
  assert.match(result.hookSpecificOutput.additionalContext, /\$geppetto-learn/);
  assert.deepEqual(await handleEvent({ ...event, hook_event_name: 'Stop' }), {});
});

test('plugin reminder signal command runs from a project with no vendored scripts', async t => {
  const cwd = fixture(t);
  put(cwd, '.geppetto/config.json', { ...config(), hooks: { learnNudge: { minToolCalls: 1 } } });
  const event = { cwd, session_id: 'plugin-signal', tool_name: 'Read', tool_input: {} };
  await handleEvent({ ...event, hook_event_name: 'PreToolUse' });
  const context = (await handleEvent({ ...event, hook_event_name: 'PostToolUse' })).hookSpecificOutput.additionalContext;
  const script = context.match(/node "([^"]+signal\.mjs)"/)?.[1]; assert.ok(script, context);
  const result = invoke(script, ['Use the existing owner', '--metric', 'complexity'], { cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(get(cwd, '.geppetto/signals.jsonl')).text, 'Use the existing owner');
  assert.equal(existsSync(resolve(cwd, '.geppetto/bin')), false);
});
