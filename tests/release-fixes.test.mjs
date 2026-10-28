import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, put, get, git, invoke, config, repo } from './helpers.mjs';
import { handleEvent } from '../skills/geppetto-adopt/scripts/hook.mjs';
import { runLearning } from '../skills/geppetto-adopt/scripts/learn-runner.mjs';
import { transcriptSlice } from '../skills/geppetto-adopt/scripts/learn-nudge.mjs';

const decision = { requirements: { changes: false }, feedback: { applies: false }, frustration: { applies: false } };
const jsonl = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
const user = text => ({ type: 'user', message: { content: text } });
function project(t) {
  const root = fixture(t);
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) assert.equal(git(root, args).status, 0);
  put(root, 'app.mjs', 'export const initial = 0;\n');
  put(root, '.geppetto/config.json', { ...config(), hooks: { learnNudge: { enabled: false }, signalLearning: { enabled: false } } });
  assert.equal(git(root, ['add', '.']).status, 0); assert.equal(git(root, ['commit', '-qm', 'baseline']).status, 0);
  return root;
}
test('learner provider input redacts untruncated secrets in transcripts, signals and turn evidence', async t => {
  const root = project(t), home = fixture(t), secret = 'sk-proj-SYNTHETIC0123456789ABCDEF';
  put(root, '.geppetto/config.json', config());
  put(root, '.geppetto/signals.jsonl', jsonl([{ id: 'secret', key: 'secret', session: 'fixture', source: 'user', category: 'workflow', status: 'open', text: `No, fix api_key=${secret}` }]));
  put(root, '.geppetto/turns.jsonl', jsonl([{ ...decision, feedback: { applies: true, on: secret, action: 'Correct the credential owner.' }, sessionId: 'privacy', transcriptOffset: 0 }]));
  const transcript = resolve(home, 'transcript.jsonl');
  put(home, 'transcript.jsonl', jsonl([user(`No, fix api_key=${secret}`), { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `echo ${secret}` } }, { type: 'tool_result', is_error: true, content: `Error: ${secret}` }] } }, { type: 'response_item', payload: { type: 'function_call_output', output: `Error: ${secret}` } }, user('No, keep this correction.')]));
  let captured;
  const result = await runLearning(root, { home, context: { learning_qualified: true, session_id: 'privacy', transcript_path: transcript }, execute: async request => { captured = request.prompt; return { decision: 'no_change', reason: 'Synthetic evidence already covered.', owner: 'app.mjs' }; } });
  assert.equal(result.status, 'unchanged'); assert.ok(captured.includes('keep this correction'));
  assert.ok(!captured.includes(secret), captured); assert.match(captured, /REDACTED/);
  const pem = '-----BEGIN PRIVATE KEY-----\n' + 'SYNTHETIC_KEY_MATERIAL'.repeat(40) + '\n-----END PRIVATE KEY-----';
  put(home, 'pem.jsonl', jsonl([{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { text: pem } }, { type: 'tool_result', is_error: true, content: pem }] } }]));
  assert.doesNotMatch((await transcriptSlice(resolve(home, 'pem.jsonl'))).text, /SYNTHETIC_KEY_MATERIAL/);
});

test('private memory provenance excludes calls, unattributed outputs and summaries even across transcript cursors', async t => {
  for (const host of ['claude', 'codex']) {
    const root = project(t), home = fixture(t), marker = 'SYNTHETIC_PRIVATE_MEMORY_DETAIL';
    put(root, '.geppetto/config.json', config());
    put(root, '.geppetto/signals.jsonl', jsonl([{ id: 'public', key: 'public', session: 'fixture', source: 'user', category: 'workflow', status: 'open', text: 'No, correct the public owner.' }, { id: 'private', key: 'private', session: 'fixture', source: 'user', category: 'workflow', status: 'open', text: `From buckets/private/facts.md: ${marker}` }]));
    put(root, '.geppetto/turns.jsonl', jsonl([{ ...decision, feedback: { applies: true, on: `buckets/private/facts.md: ${marker}`, action: 'Read the private fact.' }, sessionId: 'private', transcriptOffset: 0 }]));
    const before = jsonl([user('No, fix the public owner.')]);
    const calls = host === 'claude' ? [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'private-read', name: 'Read', input: { file_path: 'D:\\synthetic-memory\\buckets\\private\\facts.md' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'private-read', is_error: true, content: `Error: ${marker}` }] } },
    ] : [
      { type: 'response_item', payload: { type: 'function_call', call_id: 'private-read', name: 'exec_command', arguments: JSON.stringify({ cmd: 'cat D:/synthetic-memory/buckets/private/facts.md' }) } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'private-read', output: `Error: ${marker}` } },
    ];
    put(home, 'transcript.jsonl', before + jsonl([...calls, { type: 'assistant', message: { content: `From buckets/private/facts.md: ${marker}` } }, { type: 'assistant', message: { content: marker } }, user(`No, that detail was ${marker}`)]));
    const path = resolve(home, 'transcript.jsonl');
    assert.doesNotMatch((await transcriptSlice(path, Buffer.byteLength(before))).text, new RegExp(marker));
    const tailStart = Buffer.byteLength(get(home, 'transcript.jsonl'));
    put(home, 'transcript.jsonl', get(home, 'transcript.jsonl') + jsonl([user(`No, correct ${marker}`)]));
    assert.doesNotMatch((await transcriptSlice(path, tailStart)).text, new RegExp(marker));
    let captured;
    const result = await runLearning(root, { home, context: { learning_qualified: true, session_id: 'private', transcript_path: path }, execute: async request => { captured = request.prompt; return { decision: 'no_change', reason: 'Public evidence already covered.', owner: 'app.mjs' }; } });
    assert.equal(result.status, 'idle'); assert.equal(result.skipped, 'private-memory'); assert.equal(captured, undefined);
  }
});

test('private provenance recognizes path traversal and nested Codex tool arguments', async t => {
  const root = fixture(t), marker = 'SYNTHETIC_PRIVATE_TRAVERSAL';
  for (const path of ['D:/synthetic-memory/buckets/preferences/../private/facts.md', 'D:\\synthetic-memory\\buckets\\preferences\\..\\private\\facts.md']) {
    put(root, 'transcript.jsonl', jsonl([{ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: `cat ${path}` }) } }, { type: 'response_item', payload: { type: 'function_call_output', output: `Error: ${marker}` } }]));
    assert.doesNotMatch((await transcriptSlice(resolve(root, 'transcript.jsonl'))).text, new RegExp(marker));
  }
});

test('bad Stop configuration closes every delivery and logs its redacted error once per turn', async t => {
  for (const policy of [{ threshold: 0 }, { docGlobs: [42] }]) {
    const root = project(t);
    put(root, '.geppetto/config.json', { ...config(), hooks: { reviewGate: policy } });
    for (const stop_hook_active of [false, true, true, false]) {
      const result = invoke('hook.mjs', [], { cwd: root, input: JSON.stringify({ cwd: root, session_id: 'errors', turn_id: 'one', hook_event_name: 'Stop', stop_hook_active }) });
      assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), {});
    }
    const events = get(root, '.geppetto/hook-events.jsonl').trim().split('\n').map(JSON.parse);
    assert.equal(events.length, 1); assert.match(events[0].error, /Invalid hooks.reviewGate/); assert.equal(events[0].status, 'error');
    const manual = invoke('hook.mjs', ['--record-turn', '{}', '--session', 'errors', '--turn', 'one'], { cwd: root }); assert.equal(manual.status, 2);
  }
});

test('Stop catches downstream learning errors and active Stop never blocks', async t => {
  const root = project(t), event = { cwd: root, session_id: 'learning-error', turn_id: 'one' };
  await handleEvent({ ...event, hook_event_name: 'UserPromptSubmit' });
  assert.equal(invoke('hook.mjs', ['--record-turn', JSON.stringify(decision), '--session', event.session_id, '--turn', event.turn_id], { cwd: root }).status, 0);
  put(root, '.geppetto/config.json', { ...config(), hooks: { learnNudge: { minToolCalls: 0 } } });
  for (const stop_hook_active of [false, true]) assert.deepEqual(await handleEvent({ ...event, hook_event_name: 'Stop', stop_hook_active }), {});
  const errors = get(root, '.geppetto/hook-events.jsonl').trim().split('\n').map(JSON.parse).filter(row => row.status === 'error');
  assert.equal(errors.length, 1); assert.match(errors[0].error, /minToolCalls/);
});

test('failed learning launch closes Stop with one redacted diagnostic and leaves the launch retryable', async t => {
  const root = project(t), event = { cwd: root, session_id: 'launch-error', turn_id: 'one' }, secret = 'sk-proj-SYNTHETIC0123456789ABCDEF';
  put(root, '.geppetto/config.json', { ...config(), hooks: { learnNudge: { minToolCalls: 1 } } });
  await handleEvent({ ...event, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} });
  assert.equal(invoke('hook.mjs', ['--record-turn', JSON.stringify(decision), '--session', event.session_id, '--turn', event.turn_id], { cwd: root }).status, 0);
  const launchLearning = async () => { throw new Error(`Synthetic launch failed: api_key=${secret}`); };
  for (const stop_hook_active of [false, true]) assert.deepEqual(await handleEvent({ ...event, hook_event_name: 'Stop', stop_hook_active }, { launchLearning }), {});
  const log = get(root, '.geppetto/hook-events.jsonl'); assert.ok(!log.includes(secret));
  const errors = log.trim().split('\n').map(JSON.parse).filter(row => row.error); assert.equal(errors.length, 1); assert.match(errors[0].error, /Synthetic launch failed.*REDACTED/);
  const starts = []; await handleEvent({ ...event, hook_event_name: 'Stop', stop_hook_active: true }, { launchLearning: async event => { starts.push(event); } }); assert.equal(starts.length, 1);
});

test('fresh clone updates an exactly generated workflow pin but preserves user edits', t => {
  const root = fixture(t), home = fixture(t), oldPin = '4c90aa323d65024e730382ac157df7a3cf62fae7', newPin = '6d65ec218a797c05c82c3fa5a34124f8c7f2beea';
  const install = (cwd, pin, extra = []) => invoke('install.mjs', ['--target', 'codex', '--project', cwd, '--plugin-hooks', '--gate-sha', pin, ...extra], { cwd, home });
  assert.equal(install(root, oldPin, ['--begin']).status, 0);
  for (const args of [['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) assert.equal(git(root, args).status, 0);
  let result = install(root, oldPin); assert.equal(result.status, 0, result.stderr);
  result = install(root, oldPin, ['--commit']); assert.equal(result.status, 0, result.stderr);
  const clone = resolve(fixture(t), 'clone'); assert.equal(git(root, ['clone', '-q', root, clone]).status, 0);
  const workflow = '.github/workflows/pr-gate.yml'; put(clone, workflow, get(clone, workflow).replaceAll('\n', '\r\n'));
  result = install(clone, newPin); assert.equal(result.status, 0, result.stderr); assert.match(get(clone, workflow), new RegExp(newPin));
  const edited = resolve(fixture(t), 'edited'); assert.equal(git(root, ['clone', '-q', root, edited]).status, 0);
  const changed = get(edited, workflow) + '\n# User-owned customization\n'; put(edited, workflow, changed);
  result = install(edited, newPin); assert.equal(result.status, 1); assert.match(result.stderr, /not owned/); assert.equal(get(edited, workflow), changed);
});

test('tracked diffs over one MiB remain gated, recordable and invalidated by further source edits', async t => {
  const root = project(t), event = { cwd: root, session_id: 'large', turn_id: 'one' };
  await handleEvent({ ...event, hook_event_name: 'UserPromptSubmit' });
  assert.equal(invoke('hook.mjs', ['--record-turn', JSON.stringify(decision), '--session', event.session_id, '--turn', event.turn_id], { cwd: root }).status, 0);
  const source = Array.from({ length: 40000 }, (_, i) => `export const syntheticValue${i} = ${i};\n`).join(''); put(root, 'app.mjs', source);
  const bytes = git(root, ['diff', '--binary', 'HEAD'], { maxBuffer: 8 * 1024 * 1024 }).stdout; assert.ok(Buffer.byteLength(bytes) > 1024 * 1024);
  const stop = () => invoke('hook.mjs', [], { cwd: root, input: JSON.stringify({ ...event, hook_event_name: 'Stop' }) });
  let result = stop(); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).decision, 'block');
  result = invoke('hook.mjs', ['--record-review', '--base', 'HEAD', '--outcome', 'passed'], { cwd: root }); assert.equal(result.status, 0, result.stderr);
  const hash = JSON.parse(result.stdout).hash;
  assert.equal(hash, createHash('sha256').update(bytes).digest('hex'));
  result = stop(); assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), {});
  assert.equal(JSON.parse(get(root, '.geppetto/turns.jsonl')).review.status, 'reviewed');
  put(root, 'app.mjs', source + 'export const changed = true;\n');
  result = invoke('hook.mjs', ['--record-review', '--base', 'HEAD', '--outcome', 'passed'], { cwd: root }); assert.equal(result.status, 0, result.stderr); assert.notEqual(JSON.parse(result.stdout).hash, hash);
});

test('SessionStart supplies a resolved command and minimal schema once, so an ordinary first turn closes without a block', async t => {
  const root = project(t), event = { cwd: root, session_id: 'startup' };
  const plugin = JSON.parse(get(repo, 'hooks/hooks.json')), command = plugin.hooks.SessionStart[0].hooks[0].command.replace('${CLAUDE_PLUGIN_ROOT}', repo);
  const script = command.match(/^node "([^"]+)"$/)?.[1]; assert.ok(script);
  const start = () => invoke(script, [], { cwd: root, input: JSON.stringify({ ...event, hook_event_name: 'SessionStart' }) });
  const result = start(); assert.equal(result.status, 0, result.stderr);
  const text = JSON.parse(result.stdout).hookSpecificOutput?.additionalContext; assert.ok(text);
  assert.match(text, /--record-turn/); assert.match(text, /requirements.*changes.*feedback.*applies.*frustration.*applies/);
  assert.match(text, /what[\s\S]*on.*action[\s\S]*cause.*prevention/); assert.match(text, /startup/);
  assert.doesNotMatch(JSON.stringify(JSON.parse(start().stdout)), /--record-turn/);
  assert.deepEqual(await handleEvent({ ...event, hook_event_name: 'UserPromptSubmit' }), {});
  const recordScript = text.match(/node "([^"]+hook\.mjs)"/)?.[1]; assert.equal(resolve(recordScript), resolve(repo, 'skills/geppetto-adopt/scripts/hook.mjs'));
  const recorded = invoke(recordScript, ['--record-turn', JSON.stringify(decision), '--session', event.session_id], { cwd: root }); assert.equal(recorded.status, 0, recorded.stderr);
  assert.deepEqual(await handleEvent({ ...event, hook_event_name: 'Stop' }), {});
  const events = get(root, '.geppetto/hook-events.jsonl').trim().split('\n').map(JSON.parse); assert.equal(events.filter(row => row.status === 'block').length, 0);
  assert.equal(JSON.parse(get(root, '.geppetto/turns.jsonl')).sessionId, event.session_id);
});

test('SessionStart keeps the turn command scoped to repositories where the completion gate can record a turn', async t => {
  const root = fixture(t), home = fixture(t);
  put(root, '.geppetto/config.json', { ...config(), memory: { choice: 'none' } });
  assert.deepEqual(await handleEvent({ cwd: root, session_id: 'no-head', hook_event_name: 'SessionStart' }, { home }), {});
});
