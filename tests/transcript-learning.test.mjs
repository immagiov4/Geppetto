import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, delimiter } from 'node:path';
import { existsSync } from 'node:fs';
import { fixture, put, get, git, config, invoke } from './helpers.mjs';
import { transcriptSlice } from '../skills/geppetto-adopt/scripts/learn-nudge.mjs';
import { runLearning } from '../skills/geppetto-adopt/scripts/learn-runner.mjs';
import { handleEvent } from '../skills/geppetto-adopt/scripts/hook.mjs';

const user = text => ({ type: 'user', message: { content: text } });
const assistant = text => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const encode = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
test('new slice begins at byte offset and reduces Claude tools while retaining only error outputs', async t => {
  const root = fixture(t), old = encode([user('old correction è')]);
  const recent = [user('No, fix the actual owner.'), assistant('I found the cause.'), { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'x'.repeat(1000) } }] } }, { type: 'user', message: { content: [{ type: 'tool_result', is_error: false, content: 'SUCCESS_SECRET' }, { type: 'tool_result', is_error: true, content: 'ERROR ' + 'e'.repeat(1000) }] } }];
  put(root, 'transcript.jsonl', old + encode(recent) + '{"partial":');
  const slice = await transcriptSlice(resolve(root, 'transcript.jsonl'), Buffer.byteLength(old));
  assert.doesNotMatch(slice.text, /old correction|SUCCESS_SECRET|partial/); assert.match(slice.text, /actual owner|found the cause|Bash|ERROR/);
  assert.ok(slice.text.length < 1300); assert.equal(slice.offset, Buffer.byteLength(old + encode(recent))); assert.equal(slice.candidate, true);
});
test('oversize slice retains every user message and head/tail within 40 KiB', async t => {
  const root = fixture(t), rows = [user('No, keep all users'), assistant('HEAD ' + 'a'.repeat(30000)), user('middle user'), assistant('b'.repeat(90000)), user('last user'), assistant('TAIL')];
  put(root, 'transcript.jsonl', encode(rows)); const slice = await transcriptSlice(resolve(root, 'transcript.jsonl'), 0);
  for (const text of ['No, keep all users', 'middle user', 'last user', 'HEAD', 'TAIL']) assert.ok(slice.text.includes(text), text);
  assert.ok(slice.text.indexOf('No, keep all users') < slice.text.indexOf('HEAD')); assert.ok(slice.text.indexOf('middle user') < slice.text.indexOf('TAIL'));
  assert.ok(Buffer.byteLength(slice.text) <= 40960); assert.equal(slice.candidate, true);
});
test('all-user overflow retains the cursor and a truncated transcript can restart', async t => {
  const root = fixture(t), path = resolve(root, 'transcript.jsonl');
  put(root, 'transcript.jsonl', encode([user('No, ' + 'è'.repeat(30000))]));
  await assert.rejects(transcriptSlice(path), /User messages exceed/);
  put(root, 'transcript.jsonl', encode([user('No, start again')]));
  const restarted = await transcriptSlice(path, 100000); assert.match(restarted.text, /start again/); assert.ok(restarted.offset < 100000);
});
test('successful tool output mentioning error types is omitted and does not admit learning', async t => {
  const root = fixture(t); put(root, 'transcript.jsonl', encode([{ type: 'user', message: { content: [{ type: 'tool_result', is_error: false, content: 'Class Error is part of the result. SUCCESS_OUTPUT' }] } }]));
  const slice = await transcriptSlice(resolve(root, 'transcript.jsonl')); assert.equal(slice.text, ''); assert.equal(slice.candidate, false);
});
test('Codex messages, tool calls and failing output normalize without duplicate event messages', async t => {
  const root = fixture(t); put(root, 'transcript.jsonl', encode([
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Please inspect it.' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"node check"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'Process exited with code 1\nerror: missing dependency' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'DUPLICATE' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Found a fix.' }] } },
  ])); const slice = await transcriptSlice(resolve(root, 'transcript.jsonl'), 0);
  assert.match(slice.text, /Please inspect|exec_command|missing dependency|Found a fix/); assert.doesNotMatch(slice.text, /DUPLICATE/); assert.equal(slice.candidate, true);
});
function project(t, cleanup) {
  const root = fixture(t, cleanup); for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) git(root, args);
  put(root, 'README.md', '# Project'); git(root, ['add', '.']); git(root, ['commit', '-qm', 'baseline']);
  put(root, '.geppetto/config.json', { ...config(), hooks: { learnNudge: { minToolCalls: 1 } } }); return root;
}
test('long Stop starts runner directly after a previous PostToolUse reminder and starts it once', async t => {
  const cwd = project(t), starts = [], event = { cwd, session_id: 'launch', turn_id: 'turn', tool_name: 'Read', tool_input: {} };
  const options = { launchLearning: async request => { starts.push(request); } };
  await handleEvent({ ...event, hook_event_name: 'PreToolUse' }, options);
  await handleEvent({ ...event, hook_event_name: 'PostToolUse' }, options);
  await handleEvent({ ...event, hook_event_name: 'Stop' }, options); await handleEvent({ ...event, hook_event_name: 'Stop' }, options);
  assert.equal(starts.length, 1); assert.equal(starts[0].session_id, 'launch'); assert.equal(starts[0].learning_qualified, true);
});
test('explicit signals still start learning when the reminder is disabled', async t => {
  const cwd = project(t), starts = [];
  put(cwd, '.geppetto/config.json', { ...config(), hooks: { learnNudge: { enabled: false }, reviewGate: { enabled: false } } });
  put(cwd, '.geppetto/signals.jsonl', '{"id":"explicit","text":"A verified correction"}\n');
  await handleEvent({ cwd, session_id: 'explicit', turn_id: 'one', hook_event_name: 'Stop' }, { launchLearning: async event => { starts.push(event); } });
  assert.equal(starts.length, 1); assert.equal(starts[0].learning_qualified, false);
  assert.equal(git(cwd, ['check-ignore', '.geppetto/hook-state/test']).status, 0);
});
test('runner processes only new slice, retries blockers, and makes no call for an empty pre-check', async t => {
  const root = project(t), home = fixture(t), path = resolve(root, 'chat.jsonl'); let calls = 0, prompt;
  put(root, 'chat.jsonl', encode([user('Please read the file'), assistant('Done.')]));
  const event = { cwd: root, session_id: 'cursor', transcript_path: path, learning_qualified: true };
  const execute = async request => { calls++; prompt = request.prompt; return { decision: 'no_change', reason: 'The README already covers it.', owner: 'README.md' }; };
  assert.equal((await runLearning(root, { home, context: event, execute })).status, 'no-candidate'); assert.equal(calls, 0);
  const old = get(root, 'chat.jsonl'); put(root, 'chat.jsonl', old + encode([user('No, this correction matters.')]));
  const blocked = await runLearning(root, { home, context: event, execute: async () => ({ decision: 'blocked', reason: 'Owner inaccessible.', owner: 'external' }) }); assert.equal(blocked.status, 'blocked');
  await runLearning(root, { home, context: event, execute }); assert.equal(calls, 1); assert.match(prompt, /correction matters/); assert.doesNotMatch(prompt, /Please read the file/);
  assert.equal((await runLearning(root, { home, context: event, execute })).status, 'idle'); assert.equal(calls, 1);
});
test('the shipped Stop dispatch launches a detached worker without a signal and uses the subscription adapter', async t => {
  // Windows can retain the exited worker's cwd briefly; retry only this process-owning fixture's removal.
  const cleanup = { maxRetries: 3 }, cwd = project(t, cleanup), home = fixture(t, cleanup), transcript_path = resolve(home, 'chat.jsonl');
  put(home, 'chat.jsonl', encode([user('No, correct the documented owner.'), assistant('The existing README covers it.')]));
  put(home, 'node_modules/@openai/codex/bin/codex.js', `const fs=require('node:fs');let prompt='';process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{const a=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(resolve(home, 'received.json'))},JSON.stringify({prompt,args:a,workerPid:process.ppid}));fs.writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify({decision:'no_change',reason:'README already covers this correction.',owner:'README.md'}));});`);
  const env = { PATH: `${home}${delimiter}${process.env.PATH}` }, event = { cwd, session_id: 'detached', turn_id: 'one', transcript_path, tool_name: 'Read', tool_input: {} };
  for (const name of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
    const result = invoke('hook.mjs', [], { cwd, home, env, input: JSON.stringify({ ...event, hook_event_name: name }) }); assert.equal(result.status, 0, result.stderr);
  }
  const deadline = Date.now() + 15000;
  while (!existsSync(resolve(cwd, '.geppetto/learning.json')) && Date.now() < deadline) await new Promise(done => setTimeout(done, 25));
  assert.equal(JSON.parse(get(cwd, '.geppetto/learning.json')).status, 'unchanged');
  assert.match(JSON.parse(get(home, 'received.json')).prompt, /correct the documented owner/);
  assert.equal(existsSync(resolve(cwd, '.geppetto/signals.jsonl')), false);
  while (existsSync(resolve(home, '.geppetto/learn.lock')) && Date.now() < deadline) await new Promise(done => setTimeout(done, 25));
  assert.equal(existsSync(resolve(home, '.geppetto/learn.lock')), false);
  const { workerPid } = JSON.parse(get(home, 'received.json'));
  while (Date.now() < deadline) {
    try { process.kill(workerPid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise(done => setTimeout(done, 25));
  }
  assert.fail('the detached worker did not exit after releasing its lock');
});
