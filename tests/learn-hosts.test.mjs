import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fixture, put, get } from './helpers.mjs';
import { cliLearningHost, hermesLearningHost } from '../skills/geppetto-adopt/scripts/learn-hosts.mjs';

for (const name of ['codex', 'claude']) test(`${name} native JSON stream acknowledges a real child before accepting its result`, async t => {
  const root = fixture(t);
  put(root, 'double.mjs', `import { readFileSync, writeFileSync } from 'node:fs';
const prompt=readFileSync(0,'utf8');writeFileSync('call.json',JSON.stringify({args:process.argv.slice(2),prompt,child:process.env.GEPPETTO_LEARNING_CHILD}));
const output=${JSON.stringify(name === 'codex' ? [ {type:'thread.started',thread_id:'fixture-thread'}, {type:'item.completed',item:{type:'agent_message',text:'{"disposition":"pending"}'}}, {type:'turn.completed',usage:{input_tokens:1,output_tokens:1}} ] : [{type:'system',subtype:'init',session_id:'fixture-session'},{type:'result',subtype:'success',is_error:false,session_id:'fixture-session',total_cost_usd:0,result:'{"disposition":"pending"}'}])};for(const event of output)console.log(JSON.stringify(event));`);
  const host = cliLearningHost(name, { executable: process.execPath, prefix: [resolve(root, 'double.mjs')], boundary: 'fixture-only' });
  const acks = [];
  const result = await host.submit({ root, phase: 'assessment', prompt: 'UNTRUSTED_SIGNALS only', maximumUsd: '0', boundary: 'fixture-only' }, async ack => { acks.push(ack); });
  assert.equal(acks.length, 1); assert.equal(result.runId, acks[0].runId); assert.equal(result.ready, true); assert.equal(result.payload.disposition, 'pending');
  const call = JSON.parse(get(root, 'call.json')); assert.equal(call.child, '1'); assert.equal(call.prompt, 'UNTRUSTED_SIGNALS only');
  if (name === 'codex') { assert.ok(call.args.includes('--sandbox')); assert.ok(call.args.includes('read-only')); assert.equal(result.costUsd, undefined); }
  else { assert.ok(call.args.includes('--max-budget-usd')); assert.ok(call.args.includes('dontAsk')); assert.ok(call.args.includes('mcp__*')); assert.equal(result.costUsd, '0.000000'); }
});

test('process creation is not ack; malformed streams and absent executables never look running', async t => {
  const root = fixture(t); put(root, 'bad.mjs', 'console.log("not json");');
  for (const executable of [resolve(root, 'absent.exe'), process.execPath]) {
    const host = cliLearningHost('codex', { executable, prefix: [resolve(root, 'bad.mjs')], boundary: 'fixture-only' });
    let acknowledged = false;
    await assert.rejects(host.submit({ root, phase: 'assessment', prompt: 'x', maximumUsd: '0', boundary: 'fixture-only' }, async () => { acknowledged = true; }));
    assert.equal(acknowledged, false);
  }
});

test('native terminal output errors retain known billing instead of inventing a lost launch', async t => {
  const root = fixture(t);
  put(root, 'invalid-output.mjs', `import { readFileSync } from 'node:fs';readFileSync(0,'utf8');for(const event of [{type:'system',subtype:'init',session_id:'known-native'},{type:'result',subtype:'success',session_id:'known-native',is_error:false,total_cost_usd:0.125,result:'not structured JSON'}])console.log(JSON.stringify(event));`);
  const host = cliLearningHost('claude', { executable: process.execPath, prefix: [resolve(root, 'invalid-output.mjs')], boundary: 'fixture-only' });
  let acknowledged = false;
  const result = await host.submit({ root, phase: 'assessment', prompt: 'signals', maximumUsd: '1', boundary: 'fixture-only' }, async () => { acknowledged = true; });
  assert.equal(acknowledged, true); assert.equal(result.ready, true); assert.equal(result.failed, true); assert.equal(result.costUsd, '0.125000'); assert.match(result.reason, /invalid structured/);
});

test('Hermes bridge binds lifecycle request, real opaque handle ack, status and cancellation', async () => {
  const calls = [];
  const transport = async request => { calls.push(request); if (request.operation === 'launch') return { runId: 'fixture-subagent', ready: false }; if (request.operation === 'cancel') return { accepted: true, state: 'CANCEL_REQUESTED' }; return { runId: 'fixture-subagent', ready: true, costUsd: '0', payload: { disposition: 'pending' } }; };
  const host = hermesLearningHost(transport);
  let ack;
  assert.equal((await host.submit({ id: 'attempt', phase: 'assessment', prompt: 'signals', boundary: 'fixture-only' }, async a => { ack = a; })).ready, false);
  assert.equal(ack.runId, 'fixture-subagent'); assert.equal((await host.poll(ack.runId)).ready, true);
  assert.equal((await host.cancel(ack.runId)).state, 'CANCEL_REQUESTED');
  assert.equal(calls[0].operation, 'launch'); assert.equal(calls[1].operation, 'result'); assert.equal(calls[2].operation, 'cancel');
});
