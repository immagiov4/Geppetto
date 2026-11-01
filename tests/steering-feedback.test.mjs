import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { appendFile } from 'node:fs/promises';
import { fixture, put, git, config } from './helpers.mjs';
import { handleEvent, recordTurn } from '../skills/geppetto-adopt/scripts/hook.mjs';
import { recordSignal, eligibleSignals } from '../skills/geppetto-adopt/scripts/signal.mjs';

const message = text => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) + '\n';
test('a new user message inside one native turn renews the decisions before the next write', async t => {
  const cwd = fixture(t);
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) assert.equal(git(cwd, args).status, 0);
  put(cwd, '.geppetto/config.json', { ...config(), hooks: { signalLearning: { enabled: false } } });
  put(cwd, 'app.mjs', 'export const behavior = "unchanged";\n');
  git(cwd, ['add', '.']); git(cwd, ['commit', '-qm', 'Synthetic baseline']);
  const transcript = resolve(fixture(t), 'session.jsonl');
  put(cwd, transcript, message('Add comments to the channel.'));
  const event = { cwd, session_id: 'same-session', turn_id: 'same-native-turn', transcript_path: transcript };
  await handleEvent({ ...event, hook_event_name: 'UserPromptSubmit' });
  const write = { ...event, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { path: resolve(cwd, 'app.mjs'), content: 'export const behavior = "new";' } };
  assert.equal((await handleEvent(write)).hookSpecificOutput?.permissionDecision, 'deny');
  await recordTurn(cwd, event.session_id, event.turn_id, { requirements: { changes: true, what: 'Add public channel comments.' }, feedback: { applies: false }, frustration: { applies: false } });
  assert.deepEqual(await handleEvent(write), {});
  await appendFile(transcript, message('Stop: you introduced a limit I did not approve. Explain the choices before imposing it.'));
  const renewed = await handleEvent(write);
  assert.equal(renewed.hookSpecificOutput?.permissionDecision, 'deny', 'A steering message is a new user decision, although its native turn ID is unchanged.');
  await recordTurn(cwd, event.session_id, event.turn_id, { requirements: { changes: false }, feedback: { applies: true, on: 'Unapproved capacity limit.', action: 'Remove the unapproved guard and ask about capacity.' }, frustration: { applies: false }, userCorrection: true });
  const recorded = await recordSignal(cwd, { key: 'unapproved-limit', session: event.session_id, category: 'workflow', text: 'The user corrected an unapproved product limit.' });
  assert.equal(recorded.source, 'user');assert.ok((await eligibleSignals(cwd)).some(row=>row.key==='unapproved-limit'));
});


test('review feedback and tool-result envelopes do not become user corrections', async t => {
  const cwd=fixture(t);for(const args of [['init','-q'],['config','user.name','Fixture'],['config','user.email','fixture@example.invalid']])git(cwd,args);
  put(cwd,'.geppetto/config.json',{...config(),hooks:{signalLearning:{enabled:false}}});put(cwd,'app.mjs','export const stable=true;');git(cwd,['add','.']);git(cwd,['commit','-qm','Baseline']);
  const transcript=resolve(fixture(t),'session.jsonl');put(cwd,transcript,message('Implement comments.'));
  const event={cwd,session_id:'review-control',turn_id:'native',transcript_path:transcript};
  await handleEvent({...event,hook_event_name:'UserPromptSubmit'});
  const decision={requirements:{changes:false},feedback:{applies:false},frustration:{applies:false}};
  await recordTurn(cwd,event.session_id,event.turn_id,decision);
  await appendFile(transcript,JSON.stringify({type:'user',message:{role:'user',content:[{type:'tool_result',content:'A reported finding'}]}})+'\n');
  const write={...event,hook_event_name:'PreToolUse',tool_name:'Write',tool_input:{path:resolve(cwd,'app.mjs'),content:'x'}};
  assert.deepEqual(await handleEvent(write),{});
  await handleEvent({...event,hook_event_name:'PostToolUse',tool_name:'wait_agent',tool_use_id:'review-result'});
  const rearmed=await handleEvent(write);assert.equal(rearmed.hookSpecificOutput?.permissionDecision,'deny');assert.doesNotMatch(rearmed.hookSpecificOutput.permissionDecisionReason,/record requirements,/);
  await recordTurn(cwd,event.session_id,event.turn_id,{feedback:{applies:true,on:'Independent review finding.',action:'Check the finding against code.'}});
  const signal=await recordSignal(cwd,{key:'review-finding',session:event.session_id,category:'verification',text:'A reviewer found a source defect.'});assert.equal(signal.source,'agent');
});

test('pending user steering cannot be recorded as an agent signal and is evaluated once', async t => {
  const cwd=fixture(t);for(const args of [['init','-q'],['config','user.name','Fixture'],['config','user.email','fixture@example.invalid']])git(cwd,args);
  put(cwd,'.geppetto/config.json',{...config(),hooks:{signalLearning:{enabled:false}}});put(cwd,'app.mjs','export const stable=true;');git(cwd,['add','.']);git(cwd,['commit','-qm','Baseline']);
  const transcript=resolve(fixture(t),'session.jsonl');put(cwd,transcript,message('Implement comments.'));
  const event={cwd,session_id:'pending',turn_id:'native',transcript_path:transcript};await handleEvent({...event,hook_event_name:'UserPromptSubmit'});
  const decision={requirements:{changes:false},feedback:{applies:false},frustration:{applies:false}};await recordTurn(cwd,event.session_id,event.turn_id,decision);
  await appendFile(transcript,message('Actually, add a new explicit requirement.'));
  const observation={...event,hook_event_name:'PostToolUse',tool_name:'wait_agent',tool_use_id:'review-arrives-with-user'};assert.deepEqual(await handleEvent(observation),{});
  await assert.rejects(recordSignal(cwd,{key:'pending-message',session:event.session_id,category:'workflow',text:'A pending user message.'}),/Record the new user message/);
  const write={...event,hook_event_name:'PreToolUse',tool_name:'Write',tool_input:{path:resolve(cwd,'app.mjs'),content:'x'}};
  const replies=await Promise.all([handleEvent(write),handleEvent(write)]);assert.equal(replies.filter(r=>r.hookSpecificOutput?.permissionDecision==='deny').length,1);assert.match(replies.find(r=>r.hookSpecificOutput)?.hookSpecificOutput.permissionDecisionReason,/record requirements, feedback, frustration/);
  await recordTurn(cwd,event.session_id,event.turn_id,{...decision,requirements:{changes:true,what:'Explicitly requested additional behavior.'}});
  assert.deepEqual(await handleEvent(write),{});
  const signal=await recordSignal(cwd,{key:'requirements-only',session:event.session_id,category:'workflow',text:'An implementation observation, not user feedback.'});assert.equal(signal.source,'agent');
});
