import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fixture, put, get, invoke, git, scripts } from './helpers.mjs';
import { defaultConfig } from '../skills/geppetto-adopt/scripts/common.mjs';
import { adoptLearning } from '../skills/geppetto-adopt/scripts/learning-setup.mjs';
import { handleLearningHostEvent } from '../skills/geppetto-adopt/scripts/learn-host.mjs';
import { learningStep, ledgerAuthority } from '../skills/geppetto-adopt/scripts/learn-dispatch.mjs';
import { spawnSync } from 'node:child_process';
import { learningFileTool } from '../skills/geppetto-adopt/scripts/learning-files.mjs';
import { symlinkSync } from 'node:fs';
import { probeLearningHost } from '../skills/geppetto-adopt/scripts/learning-config.mjs';

function nativeFixture(root) {
  put(root, 'native.mjs', `import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(2);if(args.includes('status')){console.log('Logged in using ChatGPT');process.exit(0);}
const prompt=readFileSync(0,'utf8');appendFileSync(${JSON.stringify(resolve(root, 'calls.jsonl'))},JSON.stringify({args,child:process.env.GEPPETTO_LEARNING_CHILD})+'\\n');
const signals=JSON.parse(prompt.split('UNTRUSTED_PROJECT_SIGNALS=')[1]?.split('\\nPRIOR_DECISIONS=')[0]??'[]');
const payload=signals.length?{disposition:'isolated',rationale:'Single reusable observation recorded',evidence:signals.map(s=>({signalId:s.id,episode:s.episode,source:s.source,support:'Identified fixture source'}))}:{disposition:'keep',owner:'docs/lesson.md',rationale:'Reusable correction',evidence:['docs/lesson.md'],limitations:['synthetic']};
if(!signals.length)writeFileSync('docs/lesson.md','Reusable correction\\n');
for(const e of [{type:'thread.started',thread_id:'native-'+Date.now()},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(payload)}},{type:'turn.completed',usage:{}}])console.log(JSON.stringify(e));`);
  const config = defaultConfig();
  config.hooks.signalLearning.hosts.codex.executable = process.execPath;
  config.hooks.signalLearning.hosts.codex.prefix = [resolve(root, 'native.mjs')];
  put(root, '.geppetto/config.json', config);
}

test('fresh accepted adoption records subscription consent once and next signal event launches exactly once', async t => {
  const root = fixture(t), home = fixture(t); nativeFixture(root);
  const result = await adoptLearning(root, { accepted: true });
  assert.equal(result.enabled, true);
  await adoptLearning(root, { accepted: true });
  assert.equal(get(root, '.geppetto/authorizations').trim().split('\n').length, 1);
  const policy = JSON.parse(get(root, '.geppetto/config.json')).hooks.signalLearning;
  assert.equal(policy.enabled, true); assert.equal(policy.hosts.codex.model, 'gpt-6.1-sol'); assert.equal(policy.hosts.codex.serviceTier, 'default');
  assert.equal(policy.hosts.codex.sandbox, 'workspace-write'); assert.equal(policy.writeApproval, false);
  assert.equal(policy.maxRunsPerDay, undefined); assert.equal(policy.assessmentMaxUsd, undefined);
  assert.equal(invoke('signal.mjs', ['Reusable correction', '--metric', 'reliability'], { cwd: root, home }).status, 0);
  const runCommand = (exe, args, opts) => spawnSync(exe, args, { ...opts, windowsHide: true, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  const event = { hook_event_name: 'Stop', cwd: root };
  await handleLearningHostEvent(event, 'claude', { authorize: ledgerAuthority(root, runCommand) });
  await handleLearningHostEvent(event, 'codex', { authorize: ledgerAuthority(root, runCommand) });
  const calls = get(root, 'calls.jsonl').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 1); assert.equal(calls[0].child, '1');
  assert.ok(calls[0].args.includes('--model')); assert.ok(calls[0].args.includes('gpt-6.1-sol'));
  assert.ok(calls[0].args.includes('features.shell_tool=false'));
  assert.ok(calls[0].args.includes('features.multi_agent=false'));
});

test('missing CLI stays disabled with one actionable adoption item and no grant', async t => {
  const root = fixture(t);
  const result = await adoptLearning(root, { accepted: true, env: { PATH: '' } });
  assert.equal(result.enabled, false); assert.match(result.action, /Install Codex CLI.*codex login/);
  assert.equal(invoke('authz.mjs', ['check', 'signal-learning', '--cost', '0', '--provider', 'codex'], { cwd: root }).status, 1);
});

test('accepted adoption enables a shipped disabled policy while a recorded refusal remains declined', async t => {
  for (const declined of [false, true]) {
    const root = fixture(t); nativeFixture(root);
    const config = JSON.parse(get(root, '.geppetto/config.json'));
    config.hooks.signalLearning.enabled = false;
    if (declined) config.pillars.signalLearning = 'declined';
    put(root, '.geppetto/config.json', config);
    const result = await adoptLearning(root, { accepted: true });
    assert.equal(result.enabled, !declined);
    assert.equal(JSON.parse(get(root, '.geppetto/config.json')).hooks.signalLearning.enabled, !declined);
  }
});

test('audit gives one actionable item per unavailable feature without leaking credentials', t => {
  const root = fixture(t);
  const result = invoke('audit.mjs', ['--json'], { cwd: root, env: { PATH: '', OPENROUTER_API_KEY: '' } });
  assert.equal(result.status, 0, result.stderr);
  const audit = JSON.parse(result.stdout);
  assert.equal(audit.learning.enabled, false); assert.match(audit.learning.action, /Install Codex CLI/);
  assert.equal(audit.memoryClassifier.enabled, false); assert.match(audit.memoryClassifier.action, /Add OPENROUTER_API_KEY/);
});

test('missing subscription authentication asks for login; absent Codex can select authenticated Claude', async t => {
  const root = fixture(t);
  const policy = defaultConfig().hooks.signalLearning;
  policy.hosts.codex.executable = process.execPath;
  let probe = await probeLearningHost(policy, { env: { PATH: '' }, runCommand: () => ({ status: 1, stdout: '', stderr: 'No login' }) });
  assert.equal(probe.available, false); assert.match(probe.action, /codex login/);
  delete policy.hosts.codex.executable;
  policy.hosts.claude.executable = process.execPath;
  probe = await probeLearningHost(policy, { env: { PATH: '' }, runCommand: () => ({ status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) }) });
  assert.equal(probe.available, true); assert.equal(probe.host, 'claude');
});

test('default learning has no daily cap; only an explicitly configured cap stops launches', async t => {
  for (const maximum of [undefined, 2]) {
    const root = fixture(t); const config = defaultConfig(); config.hooks.signalLearning.maxRunsPerDay = maximum;
    put(root, '.geppetto/config.json', config); let launches = 0;
    const host = { name: 'codex', async submit(req, ack) { const runId = `run-${++launches}`; await ack({ runId }); return { ready: true, runId, costUsd: '0', payload: { disposition: 'isolated', rationale: 'Fixture', evidence: [{ signalId: `s${launches}`, support: 'Fixture' }] } }; } };
    for (let i = 1; i <= 5; i++) {
      put(root, '.geppetto/signals.jsonl', JSON.stringify({ id: `s${i}`, text: 'Reusable observation', scope: 'project', metric: 'reliability' }) + '\n');
      await learningStep(root, { host, authorize: async () => ({ decision: 'allow', reference: 'fixture consent' }) });
    }
    assert.equal(launches, maximum ?? 5);
  }
});

test('unlimited paid grants are explicit, preserve bounded grants and require personal consent', t => {
  const root = fixture(t), home = fixture(t);
  const grant = '[memory-classifier] provider=openrouter budget_usd=none per=1d scope="fixture indexed candidates" expires=never\n';
  put(root, '.geppetto/authorizations', grant);
  assert.equal(invoke('authz.mjs', ['check', 'memory-classifier', '--provider', 'openrouter', '--cost', 'none'], { cwd: root, home }).status, 1);
  put(home, '.geppetto/authorizations', grant);
  let result = invoke('authz.mjs', ['reserve', 'memory-classifier', '--provider', 'openrouter', '--cost', 'none', '--id', 'unlimited'], { cwd: root, home });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(JSON.parse(get(home, '.geppetto/ledger.jsonl')).reserved, null);
  put(root, '.geppetto/authorizations', grant.replace('budget_usd=none', 'budget_usd=1'));
  result = invoke('authz.mjs', ['check', 'memory-classifier', '--provider', 'openrouter', '--cost', 'none'], { cwd: root, home });
  assert.equal(result.status, 1); assert.match(result.stdout, /Budget|maximum/);
});

for (const writeApproval of [false, true]) test(`one reusable correction produces ${writeApproval ? 'staged changes' : 'a local commit'} on an isolated branch`, async t => {
  const root = fixture(t), home = fixture(t); nativeFixture(root);
  put(root, 'native.mjs', get(root, 'native.mjs').replace("disposition:'isolated'", "disposition:'reusable',cause:'Reusable user correction',alternatives:'Source-identified fix',cluster:null,comparisons:[]"));
  put(root, 'docs/lesson.md', 'Original lesson\n');
  assert.equal(git(root, ['init', '-q']).status, 0);
  git(root, ['config', 'user.name', 'Fixture']); git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['add', 'docs/lesson.md']); assert.equal(git(root, ['commit', '-qm', 'fixture baseline']).status, 0);
  const initial = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const config = JSON.parse(get(root, '.geppetto/config.json')); config.hooks.signalLearning.writeApproval = writeApproval; put(root, '.geppetto/config.json', config);
  await adoptLearning(root, { accepted: true });
  invoke('signal.mjs', ['Reusable user correction', '--metric', 'reliability', '--episode', 'fixture-turn', '--source', 'fixture:correction'], { cwd: root, home });
  const runCommand = (exe, args, opts) => spawnSync(exe, args, { ...opts, windowsHide: true, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  await handleLearningHostEvent({ hook_event_name: 'Stop', cwd: root }, 'codex', { authorize: ledgerAuthority(root, runCommand) });
  const state = JSON.parse(get(root, '.geppetto/learning/state.json'));
  assert.equal(state.status, 'keep', state.reason); assert.equal(state.attempts.length, 2);
  const proposal = state.attempts[1].proposal;
  assert.equal(proposal.status, writeApproval ? 'staged' : 'committed');
  assert.equal(get(proposal.path, 'docs/lesson.md'), 'Reusable correction\n');
  assert.equal(get(root, 'docs/lesson.md'), 'Original lesson\n'); assert.equal(git(root, ['rev-parse', 'HEAD']).stdout.trim(), initial);
  assert.equal(git(proposal.path, ['diff', '--cached', '--name-only']).stdout.trim(), writeApproval ? 'docs/lesson.md' : '');
  assert.equal(git(proposal.path, ['rev-parse', 'HEAD']).stdout.trim() === initial, writeApproval);
});

test('file tools can improve project owners while rejecting secrets, grants, private paths, escapes and junctions', async t => {
  const root = fixture(t), outside = fixture(t);
  await learningFileTool(root, 'Write', { path: 'docs/lesson.md', content: 'original token=private-test' });
  assert.equal(await learningFileTool(root, 'Read', { path: 'docs/lesson.md' }), 'original token=[REDACTED]');
  await learningFileTool(root, 'Edit', { path: 'docs/lesson.md', oldText: 'original', newText: 'revised' });
  assert.equal(await learningFileTool(root, 'Glob', { glob: 'docs/*.md' }), 'docs/lesson.md');
  assert.match(await learningFileTool(root, 'Grep', { text: 'revised' }), /docs\/lesson.md:1:revised/);
  for (const path of ['../escape.md', '.env', '.geppetto/authorizations', 'buckets/private/fact.md']) await assert.rejects(learningFileTool(root, 'Write', { path, content: 'blocked' }), /scope/);
  symlinkSync(outside, resolve(root, 'linked'), 'junction');
  await assert.rejects(learningFileTool(root, 'Write', { path: 'linked/escape.md', content: 'blocked' }), /symbolic/);
  await assert.rejects(learningFileTool(root, 'Write', { path: 'docs/lesson.md', content: 'blocked' }, true), /unavailable/);
});

test('the MCP bridge exposes and executes only the configured file tools', t => {
  const root = fixture(t); put(root, 'docs/lesson.md', 'Fixture lesson\n');
  const messages = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'Read', arguments: { path: 'docs/lesson.md' } } },
    { id: 4, method: 'tools/call', params: { name: 'Write', arguments: { path: 'docs/lesson.md', content: 'Rejected' } } },
  ];
  const result = spawnSync(process.execPath, [resolve(scripts, 'learning-files.mjs'), root, 'read-only', '["Read"]'], { input: messages.map(message => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n') + '\n', encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const replies = result.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(replies[1].result.tools.map(tool => tool.name), ['Read']);
  assert.equal(replies[2].result.content[0].text, 'Fixture lesson\n');
  assert.equal(replies[3].result.isError, true); assert.equal(get(root, 'docs/lesson.md'), 'Fixture lesson\n');
});
