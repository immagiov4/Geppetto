import { rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, put, get, git, invoke, config } from './helpers.mjs';
import { handleEvent } from '../skills/geppetto-adopt/scripts/hook.mjs';
import { projectDataPath } from '../skills/geppetto-adopt/scripts/project-records.mjs';
const plain = { requirements: { changes: false }, feedback: { applies: false }, frustration: { applies: false } };
async function setup(t, frustration = true) {
  const cwd = fixture(t); git(cwd, ['init','-q']); git(cwd,['config','user.name','Fixture']); git(cwd,['config','user.email','fixture@example.invalid']);
  put(cwd,'AGENTS.md','# Rules\n'); put(cwd,'.geppetto/config.json',{...config(),hooks:{reviewGate:{enabled:true,threshold:1000},learnNudge:{enabled:false}}}); git(cwd,['add','.']); git(cwd,['commit','-qm','baseline']);
  const send = (kind, extra={}) => handleEvent({cwd,session_id:'same',turn_id:'turn',hook_event_name:kind,...extra});
  const record = value => invoke('hook.mjs',['--record-turn',JSON.stringify(value),'--session','same','--turn','turn'],{cwd});
  await send('UserPromptSubmit'); assert.equal(record({...plain,frustration: frustration ? {applies:true,cause:'Repeated concrete mistake.',prevention:'Correct the owning instruction.'} : {applies:false}}).status,0);
  return {cwd,send,record};
}
for (const outcome of ['lesson','covered','one-off','blocked']) test(`frustration closes with ${outcome} and records its evidence`,async t=>{
  const {cwd,send,record}=await setup(t); if(outcome==='lesson')put(cwd,'AGENTS.md','# Rules\nVerify the actual saved file before reporting success.\n');
  const learning={outcome,reason:'The saved file must be inspected before delivery.',...(['lesson','covered'].includes(outcome)?{path:'AGENTS.md'}:{}),...(outcome==='blocked'?{path:'external-owner',key:'saved-file-check'}:{})};
  const result=record({learning});assert.equal(result.status,0,result.stderr); assert.notEqual((await send('Stop')).decision,'block');
  const events=get(cwd,projectDataPath(cwd,'hook-events.jsonl')).trim().split('\n').map(JSON.parse); assert.equal(events.filter(e=>e.hook==='learningOutcome'&&e.outcome===outcome).length,1);
  assert.equal(record({learning}).status,0); assert.equal(get(cwd,projectDataPath(cwd,'hook-events.jsonl')).trim().split('\n').map(JSON.parse).filter(e=>e.hook==='learningOutcome').length,1);
  if(outcome==='blocked')assert.equal(JSON.parse(get(cwd,projectDataPath(cwd,'signals.jsonl'))).status,'open');
});
for(const unchanged of [false,true])test(`Stop blocks once for ${unchanged?'unchanged lesson owner':'missing outcome'}`,async t=>{
 const {send,record}=await setup(t);if(unchanged)assert.equal(record({learning:{outcome:'lesson',path:'AGENTS.md',reason:'Inspect the actual saved file.'}}).status,0);
 const first=await send('Stop');assert.equal(first.decision,'block');assert.match(first.reason,/--record-turn/);assert.notEqual((await send('Stop')).decision,'block');
});
test('plain steering needs no learning outcome',async t=>{const {send}=await setup(t,false);assert.notEqual((await send('Stop')).decision,'block');});
test('an outcome check error lets Stop end and writes a diagnostic',async t=>{
 const {cwd,send,record}=await setup(t);assert.equal(record({learning:{outcome:'lesson',path:'AGENTS.md',reason:'Inspect the actual saved file.'}}).status,0);rmSync(resolve(cwd,'AGENTS.md'));mkdirSync(resolve(cwd,'AGENTS.md'));
 const result=await send('Stop');assert.notEqual(result.decision,'block');assert.match(get(cwd,projectDataPath(cwd,'hook-events.jsonl')),/error/);
});
import { appendFile } from 'node:fs/promises';
const message = text => JSON.stringify({type:'response_item',payload:{role:'user',content:[{type:'input_text',text}]}})+'\n';
test('a new user message cannot reuse a prior outcome or pre-existing dirty lesson',async t=>{
 const {cwd,send,record}=await setup(t);const transcript=cwd+'/chat.jsonl';put(cwd,'chat.jsonl',message('Initial complaint'));await send('PreToolUse',{transcript_path:transcript,tool_name:'Read',tool_input:{}});
 put(cwd,'AGENTS.md','# Rules\nInspect the actual saved file.\n');assert.equal(record({learning:{outcome:'lesson',path:'AGENTS.md',reason:'Check the written result.'}}).status,0);assert.notEqual((await send('Stop',{transcript_path:transcript})).decision,'block');
 await appendFile(transcript,message('You repeated the same mistake.'));await send('PreToolUse',{transcript_path:transcript,tool_name:'Read',tool_input:{}});
 assert.equal(record({...plain,frustration:{applies:true,cause:'Repeated the saved-file mistake.',prevention:'Inspect the actual saved file.'}}).status,0);
 assert.equal((await send('Stop',{transcript_path:transcript})).decision,'block');assert.equal(record({learning:{outcome:'lesson',path:'AGENTS.md',reason:'Check the written result.'}}).status,0);assert.notEqual((await send('Stop',{transcript_path:transcript})).decision,'block');
 const events=get(cwd,projectDataPath(cwd,'hook-events.jsonl')).trim().split('\n').map(JSON.parse);assert.equal(events.filter(e=>e.hook==='learningOutcome').length,1,'unchanged dirty file is not counted as a new lesson');
});
test('manual signal closure retains reference and reason and a later occurrence reopens it',async t=>{
 const {cwd}=await setup(t,false);const observe=session=>invoke('signal.mjs',['Inspect actual saves','--key','saved-file','--session',session,'--category','workflow','--source','agent'],{cwd});assert.equal(observe('one').status,0);assert.equal(observe('two').status,0);
 const result=invoke('signal.mjs',['--close','saved-file','--reference','https://example.invalid/pull/1','--reason','Merged the owning instruction.'],{cwd});assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(invoke('signal.mjs',['--list'],{cwd}).stdout),[]);assert.equal(observe('three').status,0);assert.deepEqual(JSON.parse(invoke('signal.mjs',['--list'],{cwd}).stdout),['saved-file']);
});
test('installer removes obsolete lock and companion temporary files only in its selected home',t=>{
 const cwd=fixture(t),home=fixture(t);put(home,'.geppetto/learn.lock','51428');put(home,'.geppetto/integrations.md.123.tmp','old');put(home,'.geppetto/worktrees/unread/lesson.md','Unread lesson');
 const result=invoke('install.mjs',['--target','claude','--project',cwd],{cwd,home});assert.equal(result.status,0,result.stderr);assert.equal(invoke('signal.mjs',['--list'],{cwd}).status,0);
 assert.throws(()=>get(home,'.geppetto/learn.lock'),/ENOENT/);assert.throws(()=>get(home,'.geppetto/integrations.md.123.tmp'),/ENOENT/);assert.equal(get(home,'.geppetto/worktrees/unread/lesson.md'),'Unread lesson');
});
test('blocked agent friction preserves configured categories and agent provenance',async t=>{
 const {cwd,send,record}=await setup(t,false);const cfg=JSON.parse(get(cwd,'.geppetto/config.json'));cfg.categories=[{id:'custom',definition:'A custom observation class.',score:'Count confirmed episodes.'}];put(cwd,'.geppetto/config.json',cfg);
 assert.equal(record({learning:{outcome:'blocked',path:'external-owner',reason:'The external repository is read-only here.',key:'external-rule'}}).status,0);await send('Stop');
 const row=JSON.parse(get(cwd,projectDataPath(cwd,'signals.jsonl')));assert.equal(row.source,'agent');assert.equal(row.category,'other');assert.equal(row.evidence,'external-owner');
});
test('an eligible signal closes with the same in-turn outcome command',async t=>{
 const {cwd,send,record}=await setup(t,false);const signal=invoke('signal.mjs',['Inspect saves','--key','save-check','--session','prior','--category','workflow','--source','agent'],{cwd});assert.equal(signal.status,0);
 assert.equal(record({learning:{outcome:'covered',path:'AGENTS.md',reason:'The existing rule owns this requirement.',key:'save-check'}}).status,0);await send('Stop');
 assert.deepEqual(JSON.parse(invoke('signal.mjs',['--list'],{cwd}).stdout),[]);
});
test('a Git-ignored file cannot be the lesson owner', async t => {
  const { cwd, send, record } = await setup(t);
  put(cwd, 'LOCAL.md', 'Private notes.\n'); put(cwd, '.git/info/exclude', 'LOCAL.md\n');
  assert.equal(record({ learning: { outcome: 'lesson', path: 'LOCAL.md', reason: 'Inspect the actual saved file.' } }).status, 0);
  const first = await send('Stop'); assert.equal(first.decision, 'block'); assert.match(first.reason, /ignored by Git/);
});
