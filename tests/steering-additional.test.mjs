import { validateTurnPolicy } from '../skills/geppetto-adopt/scripts/turn-checks.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fixture, put, git, config } from './helpers.mjs';
import { handleEvent, recordTurn } from '../skills/geppetto-adopt/scripts/hook.mjs';
import { recordSignal, localRecords } from '../skills/geppetto-adopt/scripts/signal.mjs';

const message = text => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) + '\n';
const decision = { requirements: { changes: false }, feedback: { applies: false }, frustration: { applies: false } };
function setup(t, turnChecks) {
  const cwd = fixture(t);
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) assert.equal(git(cwd, args).status, 0);
  put(cwd, '.geppetto/config.json', { ...config(), ...(turnChecks && { turnChecks }), hooks: { signalLearning: { enabled: false } } });
  put(cwd, 'app.mjs', 'export const stable = true;\n');
  assert.equal(git(cwd, ['add', '.']).status, 0); assert.equal(git(cwd, ['commit', '-qm', 'baseline']).status, 0);
  const transcript = resolve(fixture(t), 'session.jsonl');
  const event = { cwd, session_id: 'session', turn_id: 'turn', transcript_path: transcript };
  const submit = () => handleEvent({ ...event, hook_event_name: 'UserPromptSubmit' });
  const write = () => handleEvent({ ...event, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { path: resolve(cwd, 'app.mjs'), content: 'changed' } });
  return { cwd, transcript, event, submit, write };
}

test('a second prompt callback with the same turn and a new message requires a new assessment once', async t => {
  const { cwd, transcript, event, submit, write } = setup(t);
  await writeFile(transcript, message('Original request')); await submit();
  assert.equal((await write()).hookSpecificOutput?.permissionDecision, 'deny');
  await recordTurn(cwd, event.session_id, event.turn_id, decision); assert.deepEqual(await write(), {});
  await appendFile(transcript, message('Please change the original requirement.')); assert.deepEqual(await submit(), {});
  assert.equal((await write()).hookSpecificOutput?.permissionDecision, 'deny');
  await recordTurn(cwd, event.session_id, event.turn_id, decision); assert.deepEqual(await write(), {});
  await submit(); assert.deepEqual(await write(), {});
});

test('a missing or malformed transcript does not block editing and is detected after repair', async t => {
  for (const broken of ['missing', 'malformed']) {
    const { cwd, transcript, event, submit, write } = setup(t);
    await writeFile(transcript, message('Original request')); await submit();
    assert.equal((await write()).hookSpecificOutput?.permissionDecision, 'deny');
    await recordTurn(cwd, event.session_id, event.turn_id, decision); assert.deepEqual(await write(), {});
    if (broken === 'missing') { const { unlink } = await import('node:fs/promises'); await unlink(transcript); }
    else await appendFile(transcript, '{invalid json}\n');
    assert.deepEqual(await write(), {}, broken);
    await writeFile(transcript, message('Original request') + message('A new user correction.'));
    assert.equal((await write()).hookSpecificOutput?.permissionDecision, 'deny', broken);
    await recordTurn(cwd, event.session_id, event.turn_id, decision); assert.deepEqual(await write(), {});
  }
});

test('disabled turn checks remain quiet with new user messages and an unavailable transcript', async t => {
  const { transcript, submit, write } = setup(t, { checks: [] });
  await writeFile(transcript, message('Original request')); assert.deepEqual(await submit(), {}); assert.deepEqual(await write(), {});
  await appendFile(transcript, message('A new user correction.')); assert.deepEqual(await submit(), {}); assert.deepEqual(await write(), {});
  await writeFile(transcript, '{invalid json}\n'); assert.deepEqual(await write(), {});
});


test('duplicate prompt and later review keep the latest human provenance', async t => {
  const { cwd, transcript, event, submit, write } = setup(t);
  await writeFile(transcript, message('Original request')); await submit(); await recordTurn(cwd,event.session_id,event.turn_id,decision);
  await appendFile(transcript,message('You imposed a limit I did not approve.')); await write();
  const feedback={...decision,feedback:{applies:true,on:'Unapproved limit.',action:'Remove the limit.'}};
  await assert.rejects(recordTurn(cwd,event.session_id,event.turn_id,{continuation:true}),/explicit|assessment|decision/i);
  await recordTurn(cwd,event.session_id,event.turn_id,feedback); await submit();
  await handleEvent({...event,hook_event_name:'PostToolUse',tool_name:'wait_agent',tool_use_id:'review'});
  await recordTurn(cwd,event.session_id,event.turn_id,{feedback:{applies:false}});
  assert.equal((await recordSignal(cwd,{key:'latest-human',session:event.session_id,category:'workflow',text:'The user corrected the limit.'})).source,'user');
});

test('completion of a delayed initial record uses its existing assessment', async t => {
  const { cwd, transcript, event, submit, write }=setup(t), original=message('Original request');
  await writeFile(transcript,original.slice(0,-2));await submit();await recordTurn(cwd,event.session_id,event.turn_id,decision);
  await appendFile(transcript,original.slice(-2));assert.deepEqual(await write(),{});
  await appendFile(transcript,message('A genuine later correction.'));assert.equal((await write()).hookSpecificOutput?.permissionDecision,'deny');
});

test('archived human provenance survives a new turn with unrelated pending steering', async t => {
  const { cwd, transcript, event, submit, write }=setup(t);
  await writeFile(transcript,message('Original request'));await submit();await recordTurn(cwd,event.session_id,event.turn_id,decision);
  await appendFile(transcript,message('You changed my requirement.'));await write();
  await recordTurn(cwd,event.session_id,event.turn_id,{...decision,feedback:{applies:true,on:'Changed requirement.',action:'Restore agreed behavior.'}});
  await handleEvent({...event,hook_event_name:'Stop'});
  const next={...event,turn_id:'next'};await handleEvent({...next,hook_event_name:'UserPromptSubmit'});await recordTurn(cwd,event.session_id,next.turn_id,decision);
  assert.equal((await recordSignal(cwd,{key:'archived-human',session:event.session_id,turn:event.turn_id,category:'workflow',text:'The earlier user correction.'})).source,'user');
  await appendFile(transcript,message('One more current requirement.'));await handleEvent({...next,hook_event_name:'PreToolUse',tool_name:'Write',tool_input:{path:resolve(cwd,'app.mjs'),content:'changed'}});
  assert.equal((await recordSignal(cwd,{key:'archived-during-steering',session:event.session_id,turn:event.turn_id,category:'workflow',text:'Evidence for the earlier correction.'})).source,'user');
});

test('missing transcript paths emit one diagnostic and preserve native decisions', async t => {
  const { cwd, event }=setup(t);delete event.transcript_path;
  await handleEvent({...event,hook_event_name:'UserPromptSubmit'});await recordTurn(cwd,event.session_id,event.turn_id,decision);
  const write={...event,hook_event_name:'PreToolUse',tool_name:'Write',tool_input:{path:resolve(cwd,'app.mjs'),content:'changed'}};
  assert.deepEqual(await handleEvent(write),{});assert.deepEqual(await handleEvent(write),{});
  assert.equal((await localRecords(cwd,'hook-events')).filter(row=>row.hook==='turnGate'&&row.status==='transcript-unavailable').length,1);
});


test('resuming a parent turn after a child preserves its human assessment', async t => {
  const { cwd, transcript, event, submit, write }=setup(t);
  await writeFile(transcript,message('Original request'));await submit();await recordTurn(cwd,event.session_id,event.turn_id,decision);
  await appendFile(transcript,message('You changed the approved requirement.'));await write();
  await recordTurn(cwd,event.session_id,event.turn_id,{...decision,feedback:{applies:true,on:'Changed requirement.',action:'Restore agreed behavior.'}});
  const child={...event,turn_id:'child'};await handleEvent({...child,hook_event_name:'UserPromptSubmit'});await recordTurn(cwd,event.session_id,child.turn_id,decision);
  await handleEvent({...event,hook_event_name:'PostToolUse',tool_name:'wait_agent',tool_use_id:'child-finished'});
  await recordTurn(cwd,event.session_id,event.turn_id,{feedback:{applies:false}});
  assert.equal((await recordSignal(cwd,{key:'resumed-parent',session:event.session_id,turn:event.turn_id,category:'workflow',text:'The parent user correction.'})).source,'user');
});


test('a qualifying user steering episode receives its own internal learning reminder', async t => {
  for (const withNativeId of [true,false]) {
  const { cwd, transcript, event, submit }=setup(t);if(!withNativeId)delete event.turn_id;
  put(cwd,'.geppetto/config.json',{...config(),hooks:{signalLearning:{enabled:false},learnNudge:{enabled:true,minToolCalls:1,minDurationMs:100000}}});
  await writeFile(transcript,message('Original request'));await submit();await recordTurn(cwd,event.session_id,event.turn_id,decision);
  const read={...event,tool_name:'Read',tool_input:{path:resolve(cwd,'app.mjs')}};
  await handleEvent({...read,hook_event_name:'PreToolUse',tool_use_id:'first'});
  assert.match((await handleEvent({...read,hook_event_name:'PostToolUse',tool_use_id:'first'})).hookSpecificOutput?.additionalContext??'',/geppetto-learn/);
  await appendFile(transcript,message('You changed an agreed behavior.'));await handleEvent({...read,hook_event_name:'PreToolUse',tool_use_id:'steering'});
  await recordTurn(cwd,event.session_id,event.turn_id,{...decision,feedback:{applies:true,on:'Changed behavior.',action:'Restore the agreement.'}});
  assert.match((await handleEvent({...read,hook_event_name:'PostToolUse',tool_use_id:'steering'})).hookSpecificOutput?.additionalContext??'',/geppetto-learn/);
  assert.deepEqual(await handleEvent({...read,hook_event_name:'PostToolUse',tool_use_id:'steering'}),{});
  }
});


test('a duplicate prompt without a native turn ID preserves human provenance', async t => {
  const { cwd,transcript,event,submit }=setup(t);delete event.turn_id;
  await writeFile(transcript,message('A user correction.'));await submit();
  await recordTurn(cwd,event.session_id,undefined,{...decision,feedback:{applies:true,on:'Previous behavior.',action:'Correct its owner.'}});
  assert.equal((await recordSignal(cwd,{key:'without-id-first',session:event.session_id,category:'workflow',text:'The human correction.'})).source,'user');
  await submit();assert.equal((await recordSignal(cwd,{key:'without-id-duplicate',session:event.session_id,category:'workflow',text:'The same human correction.'})).source,'user');
});


test('custom checks cannot shadow archived human-assessment metadata', () => {
  assert.throws(()=>validateTurnPolicy({turnChecks:{checks:[{id:'userDecisionIndex',question:'A custom decision?',skill:'custom-skill'}]}}),/Invalid turnChecks/);
});
