import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixture, put, get, git, config } from './helpers.mjs';
import { handleEvent } from '../skills/geppetto-adopt/scripts/hook.mjs';

test('only a long turn nudges learning once per session and logs its triggering metric', async t => {
  const cwd = fixture(t); git(cwd, ['init', '-q']);
  put(cwd, '.geppetto/config.json', { ...config(), hooks: { learnNudge: { enabled: true, benchmark: null, minToolCalls: 2, minDurationMs: 1000 } } });
  const send = (name, session, now, extra = {}) => handleEvent({ hook_event_name: name, session_id: session, cwd, tool_name: 'Read', tool_input: { path: 'notes' }, ...extra }, { now: () => now });
  await send('UserPromptSubmit', 'first', 0); await send('PreToolUse', 'first', 100);
  assert.deepEqual(await send('Stop', 'first', 200), {});
  await send('UserPromptSubmit', 'first', 300); await send('PreToolUse', 'first', 400);
  assert.deepEqual(await send('Stop', 'first', 500), {}, 'short turns do not accumulate into a long turn');
  await send('PreToolUse', 'first', 600); const nudge = await send('Stop', 'first', 700);
  assert.equal(nudge.decision, 'block'); assert.match(nudge.reason, /recurring friction.*signal\.mjs/);
  assert.deepEqual(await send('Stop', 'first', 800), {});
  await send('UserPromptSubmit', 'first', 900); await send('PreToolUse', 'first', 1000); await send('PreToolUse', 'first', 1100);
  assert.deepEqual(await send('Stop', 'first', 1200), {}, 'dedupe persists across later turns in the session');
  await send('UserPromptSubmit', 'second', 0); await send('PreToolUse', 'second', 5000);
  assert.deepEqual(await send('Stop', 'second', 5500, { stop_hook_active: true }), {});
  assert.deepEqual(await send('Stop', 'second', 5500), {}, 'wall time starts at the first call');
  assert.equal((await send('Stop', 'second', 6000)).decision, 'block');
  const logs = get(cwd, '.geppetto/hook-events.jsonl').trim().split('\n').map(JSON.parse);
  assert.equal(logs.length, 2); assert.equal(logs[0].toolCalls, 2); assert.equal(logs[0].elapsedMs, 300); assert.equal(logs[1].toolCalls, 1); assert.equal(logs[1].elapsedMs, 1000);
  assert.equal(logs[0].hook, 'learnNudge'); assert.equal(logs[0].modelCalls, 0); assert.equal(logs[0].costUsd, 0);
  assert.equal(git(cwd, ['check-ignore', '.geppetto/hook-events.jsonl']).status, 0);
});

test('learning is enabled by default, disabled explicitly, and parallel Stop events fire only once', async t => {
  const cwd = fixture(t); put(cwd, '.geppetto/config.json', config());
  const send = (name, extra = {}) => handleEvent({ hook_event_name: name, session_id: 'parallel', cwd, tool_name: 'Read', tool_input: {}, ...extra }, { now: () => 0 });
  await send('PreToolUse');
  const stops = await Promise.all([handleEvent({ hook_event_name: 'Stop', session_id: 'parallel', cwd }, { now: () => 300000 }), handleEvent({ hook_event_name: 'Stop', session_id: 'parallel', cwd }, { now: () => 300000 })]);
  assert.equal(stops.filter(r => r.decision === 'block').length, 1);
  const disabled = fixture(t); put(disabled, '.geppetto/config.json', { ...config(), hooks: { learnNudge: { enabled: false, benchmark: null } } });
  assert.deepEqual(await handleEvent({ hook_event_name: 'Stop', session_id: 'off', cwd: disabled }), {});
  assert.equal(existsSync(resolve(disabled, '.geppetto/hook-state')), false);
});

test('a failed event log preserves the opportunity to deliver and measure the reminder on retry', async t => {
  const cwd = fixture(t); put(cwd, '.geppetto/config.json', { ...config(), hooks: { learnNudge: { enabled: true, benchmark: null, minToolCalls: 1, minDurationMs: 1000 } } });
  const event = { cwd, session_id: 'log-recovery', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} };
  await handleEvent(event); const log = resolve(cwd, '.geppetto/hook-events.jsonl'); mkdirSync(log);
  await assert.rejects(handleEvent({ ...event, hook_event_name: 'Stop' }));
  rmdirSync(log);
  assert.equal((await handleEvent({ ...event, hook_event_name: 'Stop' })).decision, 'block');
  assert.equal(JSON.parse(get(cwd, '.geppetto/hook-events.jsonl')).hook, 'learnNudge');
});
