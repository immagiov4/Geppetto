import { projectDataPath } from '../skills/geppetto-adopt/scripts/project-records.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fixture, put, get, config } from './helpers.mjs';
import { handleEvent } from '../skills/geppetto-adopt/scripts/hook.mjs';

function setup(t) {
  const home = fixture(t), cwd = fixture(t), memory = fixture(t);
  put(home, '.geppetto/config.json', { memory: { localPath: memory, repo: memory } });
  put(cwd, '.geppetto/config.json', { ...config(), hooks: { learnNudge: { enabled: false } } });
  const send = (event = {}) => handleEvent({ cwd, session_id: 'native-session', hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: resolve(home, '.claude/projects/example/memory/lesson.md') }, ...event }, { home });
  return { home, cwd, memory, send };
}

test('native memory writes receive one reminder per turn even when learning nudges are disabled', async t => {
  const { home, cwd, send } = setup(t);
  await send({ hook_event_name: 'UserPromptSubmit', prompt: 'First' });
  assert.deepEqual(await send({ tool_input: { file_path: resolve(cwd, 'notes.md') } }), {});
  assert.deepEqual(await send({ tool_name: 'Read' }), {});
  const results = await Promise.all([send(), send()]);
  assert.equal(results.filter(r => r.hookSpecificOutput).length, 1);
  assert.match(results.find(r => r.hookSpecificOutput).hookSpecificOutput.additionalContext, /You saved to native memory.*durable, generalizable lesson.*\$geppetto-memory/);
  assert.deepEqual(await send(), {});
  await send({ hook_event_name: 'UserPromptSubmit', prompt: 'Second' });
  assert.ok((await send({ tool_name: 'MultiEdit', tool_input: { edits: [{ file_path: resolve(home, '.claude/projects/example/memory/second.md') }] } })).hookSpecificOutput);
  const records = get(cwd, projectDataPath(cwd, 'hook-events.jsonl')).trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 2); assert.ok(records.every(row => row.hook === 'nativeMemory' && row.modelCalls === 0));
});

test('configured Claude native memory in a bucket asks to keep its index in step', async t => {
  const { cwd, memory, send } = setup(t), directory = resolve(memory, 'buckets/example/claude');
  put(cwd, '.claude/settings.local.json', { autoMemoryDirectory: directory });
  const result = await send({ turn_id: 'configured', tool_name: 'Edit', tool_input: { file_path: resolve(directory, 'MEMORY.md') } });
  assert.match(result.hookSpecificOutput.additionalContext, /keep the bucket index in step/i);
  assert.deepEqual(await send({ turn_id: 'ordinary', tool_input: { file_path: `${directory}-other/notes.md` } }), {});
});

test('Codex apply_patch uses CODEX_HOME and only patch headers identify touched memory files', async t => {
  const { home, cwd, send } = setup(t), codex = resolve(home, 'custom-codex');
  const original = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codex; t.after(() => { if (original === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = original; });
  const target = resolve(codex, 'memories/lesson.md');
  assert.ok((await send({ turn_id: 'patch', tool_name: 'apply_patch', tool_input: `*** Begin Patch\n*** Add File: ${target}\n+Lesson\n*** End Patch` })).hookSpecificOutput);
  assert.deepEqual(await send({ turn_id: 'quoted', tool_name: 'apply_patch', tool_input: { input: `*** Begin Patch\n*** Add File: ${resolve(cwd, 'notes.md')}\n+*** Update File: ${target}\n*** End Patch` } }), {});
});

for (const choice of ['native', 'none']) test(`${choice} choice silences native-memory reminders`, async t => {
  const { home, send } = setup(t);
  put(home, '.geppetto/config.json', { memory: { choice } });
  assert.deepEqual(await send(), {});
});
