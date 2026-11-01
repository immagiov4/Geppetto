import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fixture, put, get, git, invoke } from './helpers.mjs';
import { appendRecord } from '../skills/geppetto-adopt/scripts/common.mjs';
import { handleEvent } from '../skills/geppetto-adopt/scripts/hook.mjs';

async function example(t) {
  const root = fixture(t); git(root, ['init', '-q']); git(root, ['config', 'user.name', 'Fixture']); git(root, ['config', 'user.email', 'fixture@example.invalid']);
  put(root, '.geppetto/config.json', { turnChecks: [], hooks: { learnNudge: { enabled: false }, signalLearning: { enabled: true }, reviewGate: { enabled: false } } });
  put(root, 'lesson.md', 'Original\n'); git(root, ['add', '.']); git(root, ['commit', '-qm', 'base']);
  const base = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  git(root, ['checkout', '-qb', 'geppetto/learn-fixture']);
  put(root, 'lesson.md', 'Retained useful lesson\n'); git(root, ['commit', '-qam', 'learn: retain improvement']);
  const reference = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  git(root, ['checkout', '-q', '-']); put(root, 'lesson.md', 'New foreground work\n');
  await appendRecord(root, 'signals', {key:'real-case',id:'captured',session:'old',status:'open',ts:new Date().toISOString()});
  await appendRecord(root, 'signals', {key:'real-case',status:'resolved',reference,paths:['lesson.md'],through:'captured',ts:new Date().toISOString()});
  // Latest state has been overwritten and the same signal reopened: neither may hide the prior commit.
  put(root, '.git/geppetto/learning.json', {status:'unchanged'});
  await appendRecord(root, 'signals', {key:'real-case',id:'later',session:'new',status:'open',ts:new Date().toISOString()});
  return {root, reference, base};
}
const send=(cwd,turn='one',extra={})=>handleEvent({hook_event_name:'PostToolUse',session_id:'foreground',turn_id:turn,cwd,tool_name:'Read',tool_input:{path:'lesson.md'},...extra}, {launchLearning:async()=>{}});

test('a saved branch reaches internal tool context before a long-turn threshold and current work stays intact',async t=>{
 const {root,reference}=await example(t);
 const response=await send(root);
 assert.match(response.hookSpecificOutput.additionalContext,new RegExp(reference));
 assert.match(response.hookSpecificOutput.additionalContext,/verify|Verify/);
 assert.equal(get(root,'lesson.md'),'New foreground work\n');
 assert.deepEqual(await send(root),{},'same turn does not receive duplicate delivery');
 assert.ok((await send(root,'two')).hookSpecificOutput,'unsettled result remains available in a later turn');
 assert.deepEqual(await send(root,'two',{hook_event_name:'Stop'}),{},'no synthetic user message at Stop');
});

test('settling one retained commit suppresses its handoff in this checkout without hiding it in another',async t=>{
 const {root,reference}=await example(t);
 const failed=invoke('learning-delivery.mjs',['--reference',reference,'--outcome','integrated'],{cwd:root});
 assert.notEqual(failed.status,0,'a disposition needs its actual rationale');
 const result=invoke('learning-delivery.mjs',['--reference',reference,'--outcome','discarded','--reason','The newer foreground procedure already covers it.'],{cwd:root});
 assert.equal(result.status,0,result.stderr);
 assert.deepEqual(await send(root,'new'),{});
 const linked=resolve(root,'linked');
 git(root,['worktree','add','-q','--detach',linked,'HEAD']);t.after(()=>git(root,['worktree','remove','--force',linked]));
 assert.ok((await send(linked,'other',{session_id:'another'})).hookSpecificOutput, 'another checkout still needs its own integration decision');
 const unknown=invoke('learning-delivery.mjs',['--reference','a'.repeat(40),'--outcome','integrated','--reason','unsupported'],{cwd:root});
 assert.notEqual(unknown.status,0,'only recorded learning commits may be settled');
});

test('no-change and staged decisions do not create pending committed proposals',async t=>{
 const root=fixture(t);put(root,'.geppetto/config.json',{hooks:{learnNudge:{enabled:false},signalLearning:{enabled:true},reviewGate:{enabled:false}}});
 await appendRecord(root,'signals',{key:'none',session:'s',status:'resolved',reference:'no-change:synthetic',ts:new Date().toISOString()});
 put(root,'.geppetto/learning.json',{status:'staged',branch:'geppetto/learn-staged'});
 assert.deepEqual(await send(root),{});
});

test('concurrent completions deliver a retained proposal once',async t=>{
 const {root}=await example(t);
 await send(root,'one',{hook_event_name:'UserPromptSubmit'});
 const results=await Promise.all([send(root),send(root),send(root)]);
 assert.equal(results.filter(result=>result.hookSpecificOutput).length,1);
});

test('disabled nudges still hand off pending results on later prompts without native turn IDs', async t=>{
 const {root}=await example(t);
 await send(root,undefined,{turn_id:undefined,hook_event_name:'UserPromptSubmit'});
 assert.ok((await send(root,undefined,{turn_id:undefined})).hookSpecificOutput);
 assert.deepEqual(await send(root,undefined,{turn_id:undefined}),{});
 await send(root,undefined,{turn_id:undefined,hook_event_name:'UserPromptSubmit'});
 assert.ok((await send(root,undefined,{turn_id:undefined})).hookSpecificOutput,'the unresolved proposal must remain visible in a later turn');
});

test('recreating a worktree at the same path cannot inherit its old integration decision',async t=>{
 const {root,reference}=await example(t),linked=resolve(root,'reused');
 git(root,['worktree','add','-q','--detach',linked,'HEAD']);
 const result=invoke('learning-delivery.mjs',['--reference',reference,'--outcome','discarded','--reason','Current checkout already has another owner.'],{cwd:linked});
 assert.equal(result.status,0,result.stderr);
 assert.deepEqual(await send(linked),{});
 git(root,['worktree','remove','--force',linked]);
 git(root,['worktree','add','-q','--detach',linked,'HEAD']);
 assert.ok((await send(linked)).hookSpecificOutput,'the fresh checkout has not integrated or rejected this proposal');
});
