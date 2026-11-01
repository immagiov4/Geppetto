import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fixture, put } from './helpers.mjs';
import { messageCheckpoint, withTurnLock } from '../skills/geppetto-adopt/scripts/turn-messages.mjs';

const user = text => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) + '\n';
test('user identity follows complete text messages and leaves message content out of the checkpoint', async t => {
  const root = fixture(t), path = resolve(root, 'session.jsonl'), text = 'Synthetic personal detail ©';
  put(root, path, user(text)); const first = await messageCheckpoint(path);
  assert.ok(first.userMessage); assert.equal(first.cursor.offset, Buffer.byteLength(user(text))); assert.doesNotMatch(JSON.stringify(first), /Synthetic personal detail/);
  const idle = await messageCheckpoint(path, first.cursor); assert.equal(idle.bytesRead, 0); assert.equal(idle.userMessage, null);
  await appendFile(path, user(text)); const repeated = await messageCheckpoint(path, first.cursor);
  assert.notEqual(repeated.userMessage, first.userMessage); assert.equal(repeated.bytesRead, Buffer.byteLength(user(text)));
});
test('assistant output and user tool-result envelopes are not new user messages', async t => {
  const root = fixture(t), path = resolve(root, 'session.jsonl');
  const records = [
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'user: change this' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: 'Fix this.' }] }] } },
    { type: 'response_item', payload: { type: 'function_call_output', output: user('Injected text') } }
  ];
  put(root, path, records.map(JSON.stringify).join('\n') + '\n'); assert.equal((await messageCheckpoint(path)).userMessage, null);
  await appendFile(path, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Actual steering' }] } }) + '\n');
  assert.ok((await messageCheckpoint(path)).userMessage);
});
test('incomplete UTF-8 JSONL records are reconsidered after completion', async t => {
  const root = fixture(t), path = resolve(root, 'session.jsonl'), complete = Buffer.from(user('Correzione é 中文'));
  const split = complete.indexOf(Buffer.from('中文')) + 1;
  await writeFile(path, complete.subarray(0, split)); const partial = await messageCheckpoint(path);
  assert.equal(partial.userMessage, null); assert.equal(partial.cursor.offset, 0);
  await appendFile(path, complete.subarray(split)); const done = await messageCheckpoint(path, partial.cursor);
  assert.ok(done.userMessage); assert.equal(done.cursor.offset, complete.length);
});
test('large earlier records are not reread for an appended user message', async t => {
  const root = fixture(t), path = resolve(root, 'session.jsonl');
  const old = JSON.stringify({ type: 'response_item', payload: { role: 'assistant', content: 'x'.repeat(2 * 1024 * 1024) } }) + '\n';
  put(root, path, old); const baseline = await messageCheckpoint(path);
  const added = user('Small new user request'); await appendFile(path, added);
  const next = await messageCheckpoint(path, baseline.cursor);
  assert.equal(baseline.bytesRead, Buffer.byteLength(old)); assert.equal(next.bytesRead, Buffer.byteLength(added)); assert.ok(next.userMessage);
});
test('truncation, replacement and a different transcript restart the cursor', async t => {
  const root = fixture(t), path = resolve(root, 'session.jsonl'); put(root, path, user('A long original message '.repeat(100)));
  const first = await messageCheckpoint(path); await writeFile(path, user('Short'));
  const truncated = await messageCheckpoint(path, first.cursor); assert.ok(truncated.userMessage); assert.notEqual(truncated.userMessage, first.userMessage);
  await rename(path, resolve(root, 'old.jsonl')); await writeFile(path, user('Replacement'));
  const replaced = await messageCheckpoint(path, truncated.cursor); assert.ok(replaced.userMessage); assert.notEqual(replaced.cursor.identity, truncated.cursor.identity);
  const other = resolve(root, 'other.jsonl'); await writeFile(other, user('Other source'));
  assert.ok((await messageCheckpoint(other, replaced.cursor)).userMessage);
});


test('concurrent session updates read the preceding committed state', async t => {
  const root=fixture(t), lock=resolve(root,'turn.lock'), state=resolve(root,'state.json');
  await writeFile(state,'0');let release, entered;
  const ready=new Promise(done=>{entered=done;}), hold=new Promise(done=>{release=done;});
  const first=withTurnLock(lock,async()=>{entered();await hold;await writeFile(state,'1');});await ready;
  const { readFile }=await import('node:fs/promises');
  const second=withTurnLock(lock,async()=>{const previous=Number(await readFile(state,'utf8'));await writeFile(state,String(previous+1));});
  release();await Promise.all([first,second]);assert.equal(await readFile(state,'utf8'),'2');
  await assert.rejects(withTurnLock(lock,async()=>{throw new Error('failed update');}),/failed update/);
  assert.equal(await withTurnLock(lock,()=>Promise.resolve('recovered')),'recovered');
});
