import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, put, get, git, invoke } from './helpers.mjs';
import { handleMemoryEvent } from '../skills/geppetto-adopt/scripts/memory-hook.mjs';
import { handleEvent } from '../skills/geppetto-adopt/scripts/hook.mjs';

const records = root => get(root, '.geppetto/hook-events.jsonl').trim().split('\n').map(JSON.parse);

test('project-wide memory results retain their originating sessions without copying event payloads', async t => {
  const cwd = fixture(t), home = fixture(t), memory = fixture(t);
  git(cwd, ['init', '-q']);
  put(cwd, '.geppetto/config.json', { memory: { repo: 'https://example.invalid/memory', localPath: memory } });
  const common = { cwd, prompt: 'SYNTHETIC_PROMPT_NOT_FOR_LOGGING', tool_input: { secret: 'SYNTHETIC_TOOL_INPUT' } };
  await handleMemoryEvent({ ...common, hook_event_name: 'SessionStart', session_id: 'memory-session' }, { home });
  const [memoryResult] = records(cwd);
  assert.equal(memoryResult.sessionId, 'memory-session');
  assert.equal(memoryResult.status, 'unavailable'); assert.equal(memoryResult.turnId, undefined);
  assert.doesNotMatch(JSON.stringify(records(cwd)), /SYNTHETIC_PROMPT|SYNTHETIC_TOOL_INPUT/);
});

test('learning reminders expose native identifiers alongside existing deduplication identifiers', async t => {
  const cwd = fixture(t); git(cwd, ['init', '-q']);
  put(cwd, '.geppetto/config.json', { hooks: { learnNudge: { enabled: true, minToolCalls: 1, minDurationMs: 1000 } } });
  const event = { cwd, session_id: 'working-session', turn_id: 'working-turn', tool_use_id: 'one', tool_name: 'Read', tool_input: { path: 'notes.md' } };
  await handleEvent({ ...event, hook_event_name: 'UserPromptSubmit' }, { now: () => 1 });
  await handleEvent({ ...event, hook_event_name: 'PreToolUse' }, { now: () => 2 });
  await handleEvent({ ...event, hook_event_name: 'PostToolUse' }, { now: () => 3 });
  const [row] = records(cwd);
  assert.equal(row.sessionId, 'working-session'); assert.equal(row.turnId, 'working-turn');
  assert.equal(row.turn, 'working-turn'); assert.equal(row.session.length, 64);
});

test('background learning errors retain the triggering session and turn', t => {
  const cwd = fixture(t), home = fixture(t); git(cwd, ['init', '-q']);
  put(cwd, '.geppetto/config.json', { hooks: { signalLearning: { enabled: true } } });
  put(cwd, '.geppetto/signals.jsonl', '{"id":"pending","key":"pending","session":"fixture","source":"user","category":"workflow","status":"open","text":"Retain the correction"}\n');
  const result = invoke('learn-runner.mjs', [], { cwd, home, input: JSON.stringify({ cwd, session_id: 'learning-session', turn_id: 'learning-turn', hook_event_name: 'Stop' }) });
  assert.equal(result.status, 1);
  const [row] = records(cwd);
  assert.equal(row.status, 'error'); assert.equal(row.sessionId, 'learning-session'); assert.equal(row.turnId, 'learning-turn');
});
