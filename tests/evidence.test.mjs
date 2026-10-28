import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fixture, put, get, invoke, git, config, scripts } from './helpers.mjs';
import { recordSignal, signalArchive, eligibleSignals, resolveSignals, maintainEvidence } from '../skills/geppetto-adopt/scripts/signal.mjs';
import { runLearning } from '../skills/geppetto-adopt/scripts/learn-runner.mjs';
import { learningFileTool } from '../skills/geppetto-adopt/scripts/learner-tools.mjs';
import { defaultConfig } from '../skills/geppetto-adopt/scripts/common.mjs';
import { learningAudit } from '../skills/geppetto-adopt/scripts/audit.mjs';
import { handleEvent, recordTurn } from '../skills/geppetto-adopt/scripts/hook.mjs';
const rows = records => records.map(JSON.stringify).join('\n') + '\n';
const observation = (key, session, extra = {}) => ({ key, session, category: 'efficiency', text: 'Synthetic repeated work', ...extra });
function observeWorker(home) {
  const path = resolve(home, 'observe-worker.cjs');
  put(home, 'observe-worker.cjs', `if(process.argv[1]?.endsWith('learn-runner.mjs'))require('node:fs').writeFileSync(${JSON.stringify(resolve(home, 'worker.pid'))},String(process.pid));`);
  return `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(path)}`;
}
async function waitForWorker(home, deadline) {
  const pid = Number(get(home, 'worker.pid'));
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise(done => setTimeout(done, 25));
  }
  assert.fail('The detached recording worker did not exit after releasing its lock.');
}
test('the recording CLI starts its default worker at threshold and exits without a module cycle', async t => {
  const root = fixture(t, { maxRetries: 3 }), home = fixture(t, { maxRetries: 3 });
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) git(root, args);
  put(root, 'README.md', '# Owner\n'); git(root, ['add', '.']); git(root, ['commit', '-qm', 'baseline']);
  put(root, '.geppetto/config.json', { hooks: { signalLearning: { host: 'codex' } }, memory: { choice: 'none' } });
  put(root, '.geppetto/signals.jsonl', rows([{ id: 'seed', key: 'cli-case', category: 'workflow', source: 'agent', session: 'one', status: 'open', text: 'First observation' }]));
  put(home, 'node_modules/@openai/codex/bin/codex.js', "const fs=require('fs');process.stdin.resume();process.stdin.on('end',()=>{const a=process.argv.slice(2);fs.writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify({decision:'no_change',reason:'The existing owner covers the evidence.',owner:'README.md'}));});");
  const result = spawnSync(process.execPath, [resolve(scripts, 'signal.mjs'), 'Second observation', '--key', 'cli-case', '--category', 'workflow', '--session', 'two'], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000, env: { ...process.env, NODE_OPTIONS: observeWorker(home), HOME: home, USERPROFILE: home, CODEX_HOME: resolve(home, '.codex'), PATH: `${home}${delimiter}${process.env.PATH}` } });
  assert.equal(result.status, 0, result.stderr);
  const deadline = Date.now() + 15000;
  while ((!existsSync(resolve(root, '.geppetto/learning.json')) || existsSync(resolve(home, '.geppetto/learn.lock'))) && Date.now() < deadline) await new Promise(done => setTimeout(done, 25));
  assert.equal(JSON.parse(get(root, '.geppetto/learning.json')).status, 'unchanged');
  await waitForWorker(home, deadline);
});

test('immediate and weekly learning retain transcript privacy provenance before a provider call', async t => {
  const root = fixture(t, { maxRetries: 3 }), home = fixture(t, { maxRetries: 3 }), transcript = resolve(home, 'private-session.jsonl');
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) git(root, args);
  put(root, 'README.md', '# Owner\n'); git(root, ['add', '.']); git(root, ['commit', '-qm', 'baseline']);
  put(root, '.geppetto/config.json', { hooks: { signalLearning: { host: 'codex' } }, memory: { choice: 'none' } });
  put(home, 'private-session.jsonl', rows([{ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"cat D:/synthetic/buckets/private/facts.md"}' } }]));
  put(root, '.geppetto/signals.jsonl', rows([{ id: 'seed', key: 'private-context', category: 'workflow', source: 'agent', session: 'one', status: 'open', text: 'First observation' }]));
  await handleEvent({ cwd: root, session_id: 'two', turn_id: 'turn', transcript_path: transcript, hook_event_name: 'UserPromptSubmit' });
  put(home, 'node_modules/@openai/codex/bin/codex.js', `const fs=require('fs');process.stdin.resume();process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(resolve(home, 'provider-called'))},'yes');const a=process.argv.slice(2);fs.writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify({decision:'no_change',reason:'Owner covers it.',owner:'README.md'}));});`);
  const result = spawnSync(process.execPath, [resolve(scripts, 'signal.mjs'), 'Synthetic private summary without its path', '--key', 'private-context', '--category', 'workflow', '--session', 'two'], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000, env: { ...process.env, NODE_OPTIONS: observeWorker(home), HOME: home, USERPROFILE: home, CODEX_HOME: resolve(home, '.codex'), PATH: `${home}${delimiter}${process.env.PATH}` } });
  assert.equal(result.status, 0, result.stderr);
  const deadline = Date.now() + 15000;
  while ((!existsSync(resolve(root, '.geppetto/hook-events.jsonl')) || existsSync(resolve(home, '.geppetto/learn.lock'))) && Date.now() < deadline) await new Promise(done => setTimeout(done, 25));
  assert.equal(existsSync(resolve(home, 'provider-called')), false);
  assert.equal((await signalArchive(root)).find(row => row.key === 'private-context').status, 'open');
  const weekly = await runLearning(root, { home, execute: () => assert.fail('Private provenance must also cover weekly backstop runs') });
  assert.equal(weekly.skipped, 'private-memory');
  await waitForWorker(home, deadline);
});
test('approved defaults preserve ordered assignment and secondary effects remain attributes', async t => {
  assert.deepEqual(defaultConfig().categories.map(row => row.id), ['security', 'verification', 'workflow', 'efficiency', 'communication', 'behavior']);
  const root = fixture(t), attributes = { episode: 'synthetic-episode', effects: ['frustration', 'rework'], note: 'token=synthetic-secret' };
  const result = invoke('signal.mjs', ['Synthetic episode', '--key', 'episode', '--session', 'one', '--category', 'workflow', '--attributes', JSON.stringify(attributes)], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  const entry = (await signalArchive(root))[0];
  assert.equal(entry.category, 'workflow'); assert.deepEqual(entry.attributes.effects, attributes.effects); assert.equal(entry.attributes.note, 'token=[REDACTED]');
});

test('agent threshold uses three distinct sessions when configured, and failed launches retain eligible evidence', async t => {
  const root = fixture(t), calls = [];
  put(root, '.geppetto/config.json', { hooks: { signalLearning: { minSessions: 3 } } });
  const launch = async event => calls.push(event);
  for (const session of ['one', 'one', 'two']) await recordSignal(root, observation('threshold', session), { launch });
  assert.equal(calls.length, 0);
  await assert.rejects(recordSignal(root, observation('threshold', 'three'), { launch: async () => { throw new Error('Synthetic launch failure'); } }), /launch failure/);
  assert.equal((await eligibleSignals(root)).length, 1);
  await handleEvent({ cwd: root, session_id: 'three', turn_id: 'retry', hook_event_name: 'Stop' }, { launchLearning: launch });
  assert.equal(calls.length, 1);
});

test('shell read telemetry ignores neighboring writes and listings and excludes private aliases', async t => {
  const root = fixture(t), home = fixture(t), event = { cwd: root, session_id: 'shell-reads', hook_event_name: 'PostToolUse', tool_name: 'exec_command' };
  put(root, '.geppetto/config.json', { hooks: { learnNudge: { enabled: false }, signalLearning: { enabled: false } } });
  await handleEvent({ ...event, tool_input: { cmd: 'Get-Content "skills/read/SKILL.md"; Set-Content "skills/write/SKILL.md" x; rg --files "skills/list/SKILL.md"' } }, { home });
  assert.deepEqual(get(root, '.geppetto/reads.jsonl').trim().split('\n').map(JSON.parse).map(row => row.path), [resolve(root, 'skills/read/SKILL.md')]);
  await handleEvent({ ...event, tool_input: { cmd: 'cat "skills/failed/SKILL.md"' }, tool_response: 'Process exited with code 1' }, { home });
  assert.equal(get(root, '.geppetto/reads.jsonl').trim().split('\n').length, 1);
});

test('audit limits read observations by the selected window and keeps private evidence out of maintenance', async t => {
  const root = fixture(t), home = fixture(t), memory = fixture(t);
  put(home, '.geppetto/config.json', { memory: { localPath: memory, repo: memory } });
  put(memory, 'index.md', '# Index'); put(memory, 'buckets/preferences/page.md', '# Public'); put(memory, 'buckets/private/page.md', '# Private');
  put(root, '.geppetto/reads.jsonl', rows([{ ts: '2026-10-01T00:00:00Z', path: resolve(memory, 'buckets/preferences/page.md'), session: 'one', kind: 'memory' }]));
  put(root, '.geppetto/signals.jsonl', rows([{ id: 'private', key: 'private', session: 'one', status: 'open', category: 'other', evidence: resolve(memory, 'buckets/private/page.md'), text: 'PRIVATE_PAYLOAD' }]));
  assert.equal((await learningAudit(root, { home })).neverRead.includes(resolve(memory, 'buckets/preferences/page.md')), false);
  const report = await learningAudit(root, { home, since: '2026-10-02T00:00:00Z' });
  assert.ok(report.neverRead.includes(resolve(memory, 'buckets/preferences/page.md'))); assert.doesNotMatch(JSON.stringify(report), /PRIVATE_PAYLOAD|buckets[/\\]+private/);
});
test('a flagged active user turn starts learning immediately before Stop writes the completed turn record', async t => {
  const root = fixture(t), starts = [];
  git(root, ['init', '-q']); git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'baseline']);
  put(root, '.geppetto/config.json', config());
  await handleEvent({ cwd: root, session_id: 'active', turn_id: 'turn', hook_event_name: 'UserPromptSubmit' });
  await recordTurn(root, 'active', 'turn', { requirements: { changes: false }, feedback: { applies: true, on: 'The user corrected the result.', action: 'Fix the existing owner.' }, frustration: { applies: false } });
  const entry = await recordSignal(root, observation('active-user', 'active'), { launch: async event => starts.push(event) });
  assert.equal(entry.source, 'user'); assert.equal(starts.length, 1);
});
test('replacing categories in config changes validation without changing code', async t => {
  const root = fixture(t), category = { id: 'configured-class', definition: 'A broad configured problem class.', score: 'Count evidenced keys per distinct session.' };
  put(root, '.geppetto/config.json', { categories: [category], hooks: { signalLearning: { enabled: false } } });
  await recordSignal(root, observation('configured', 's', { category: category.id }));
  await assert.rejects(recordSignal(root, observation('old-default', 's')), /configured-class, other/);
  assert.deepEqual((await learningAudit(root, { home: fixture(t) })).categories[0], { ...category, keys: 1, sessions: 1 });
});

test('curation proposes a class only with three other keys across sessions, and merge preserves independent evidence', async t => {
  const root = fixture(t), launch = async () => {}, category = { id: 'proposed-class', definition: 'A shared class.', score: 'Count supported keys and sessions.' };
  for (const [key, session] of [['first', 'one'], ['second', 'two'], ['third', 'two']]) await recordSignal(root, observation(key, session, { category: 'other', evidence: 'fixture.log:1' }), { launch });
  await assert.rejects(maintainEvidence(root, { action: 'category', keys: ['first', 'second'], category, reason: 'Shared class' }), /three/);
  await maintainEvidence(root, { action: 'category', keys: ['first', 'second', 'third'], category, reason: 'All evidence documents a common cause.' });
  assert.equal(JSON.parse(get(root, '.geppetto/category-proposals.jsonl')).category.id, category.id);
  await learningFileTool(root, 'MaintainEvidence', { action: 'merge', keys: ['first', 'second'], reason: 'Same cause' }, false, null, { maintenance: true });
  assert.equal((await signalArchive(root)).find(row => row.key === 'first').status, 'merged-into:second');
  assert.equal((await eligibleSignals(root)).find(row => row.key === 'second').sessions.length, 2);
  await assert.rejects(learningFileTool(root, 'MaintainEvidence', { action: 'merge' }), /unavailable/);
});

test('agent signals stay pending below threshold and learner changes carry keys without consuming newer occurrences', async t => {
  const root = fixture(t), home = fixture(t), launch = async () => {};
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) git(root, args);
  put(root, 'lesson.md', 'Original owner\n'); git(root, ['add', '.']); git(root, ['commit', '-qm', 'baseline']);
  await recordSignal(root, observation('redo', 'one'), { launch });
  assert.equal((await runLearning(root, { home, execute: () => assert.fail('below threshold') })).status, 'idle');
  await recordSignal(root, observation('redo', 'two'), { launch });
  const result = await runLearning(root, { home, execute: async ({ cwd }) => {
    put(cwd, 'lesson.md', 'Improved owner\n');
    await recordSignal(root, observation('redo', 'three'), { launch });
    return { decision: 'applied', owner: 'lesson.md', reason: 'Corrected repeated work at the owner.' };
  } });
  assert.equal(result.status, 'committed'); assert.match(git(result.path, ['log', '-1', '--format=%B']).stdout, /Evidence: redo/);
  assert.equal((await signalArchive(root)).find(row => row.key === 'redo').status, 'open');
  assert.equal(get(root, 'lesson.md'), 'Original owner\n');
});

test('only open keys are offered and one key counts once in each session', async t => {
  const root = fixture(t), starts = [], launch = async event => starts.push(event);
  await recordSignal(root, observation('redo', 'one'), { launch });
  await recordSignal(root, observation('redo', 'one'), { launch });
  assert.equal((await signalArchive(root)).length, 1); assert.equal(starts.length, 0);
  await recordSignal(root, observation('redo', 'two'), { launch });
  assert.equal(starts.length, 1); assert.deepEqual((await eligibleSignals(root)).map(row => row.key), ['redo']);
  await resolveSignals(root, ['redo'], { reference: 'abc', paths: ['lesson.md'], reason: 'Fixed owner' });
  const list = invoke('signal.mjs', ['--list'], { cwd: root }); assert.equal(list.status, 0, list.stderr); assert.deepEqual(JSON.parse(list.stdout), []);
  await recordSignal(root, observation('redo', 'two'), { launch });
  assert.equal((await signalArchive(root)).find(row => row.key === 'redo').sessions.length, 2);
  assert.equal((await learningAudit(root, { home: fixture(t) })).outcomes[0].didNotFix, true);
  await resolveSignals(root, ['redo'], { reference: 'def', paths: ['lesson.md'], reason: 'Fixed the remaining case' });
  await recordSignal(root, observation('new', 'three'), { launch });
  assert.deepEqual(JSON.parse(invoke('signal.mjs', ['--list'], { cwd: root }).stdout), ['new']);
});

test('user provenance comes from flagged feedback or frustration, agent threshold and open limit are configurable', async t => {
  const root = fixture(t), starts = [], launch = async event => starts.push(event);
  await assert.rejects(recordSignal(root, observation('user-fix', 'u', { source: 'user' }), { launch }), /turn record/);
  put(root, '.geppetto/turns.jsonl', rows([{ sessionId: 'u', turnId: 'turn', feedback: { applies: true } }]));
  await recordSignal(root, observation('user-fix', 'u', { turn: 'turn', source: 'user' }), { launch }); assert.equal(starts.length, 1);
  put(root, '.geppetto/config.json', { hooks: { signalLearning: { minSessions: 3, maxOpenKeys: 1 } } });
  await recordSignal(root, observation('second', 's'), { launch }); assert.equal(starts.length, 2);
  assert.equal((await eligibleSignals(root)).length, 2);
  put(root, '.geppetto/config.json', { hooks: { signalLearning: { enabled: false } } });
  await recordSignal(root, observation('third', 's'), { launch }); assert.equal(starts.length, 2);
});

test('review feedback on a completed turn retains agent provenance when the user message was unflagged', async t => {
  const root = fixture(t), starts = [];
  put(root, '.geppetto/turns.jsonl', rows([{ sessionId: 'review', turnId: 'old', feedback: { applies: true }, decisions: [{ decision: { feedback: { applies: false }, frustration: { applies: false } } }, { decision: { feedback: { applies: true } } }] }]));
  const entry = await recordSignal(root, observation('review-result', 'review', { turn: 'old' }), { launch: async event => starts.push(event) });
  assert.equal(entry.source, 'agent'); assert.equal(starts.length, 0);
});

test('agent-discovered observations keep their threshold during a flagged user turn', async t => {
  const root = fixture(t), starts = [];
  put(root, '.geppetto/turns.jsonl', rows([{ sessionId: 'mixed', feedback: { applies: true } }]));
  const entry = await recordSignal(root, observation('agent-discovery', 'mixed', { source: 'agent' }), { launch: async event => starts.push(event) });
  assert.equal(entry.source, 'agent'); assert.equal(starts.length, 0);
});

test('an unrelated below-threshold key does not relaunch learning for an older pending key', async t => {
  const root = fixture(t), starts = [], launch = async event => starts.push(event);
  put(root, '.geppetto/turns.jsonl', rows([{ sessionId: 'user', feedback: { applies: true } }]));
  await recordSignal(root, observation('user-pending', 'user'), { launch });
  await recordSignal(root, observation('agent-once', 'agent'), { launch });
  assert.equal(starts.length, 1);
});

test('category boundary lists supported categories and requires concrete evidence for other; legacy metrics remain readable', async t => {
  const root = fixture(t);
  const bad = invoke('signal.mjs', ['problem', '--key', 'bad', '--session', 's', '--category', 'invented'], { cwd: root });
  assert.equal(bad.status, 2); assert.match(bad.stderr, /security.*verification.*workflow.*efficiency.*communication.*behavior.*other/);
  await assert.rejects(recordSignal(root, observation('misc', 's', { category: 'other' })), /evidence/);
  await recordSignal(root, observation('misc', 's', { category: 'other', evidence: 'build.log:12', source: 'agent' }), { launch: async () => {} });
  put(root, '.geppetto/signals.jsonl', get(root, '.geppetto/signals.jsonl') + rows([{ id: 'legacy', metric: 'latency', text: 'Old signal' }]));
  assert.equal((await signalArchive(root)).find(row => row.id === 'legacy').metric, 'latency');
  assert.deepEqual(await eligibleSignals(root), []);
  assert.deepEqual(JSON.parse(invoke('signal.mjs', ['--list'], { cwd: root }).stdout), ['misc']);
});

test('PostToolUse records successful memory and skill reads only, with no contents or private paths', async t => {
  const root = fixture(t), home = fixture(t), memory = fixture(t);
  put(home, '.geppetto/config.json', { memory: { localPath: memory, repo: memory } });
  put(root, '.geppetto/config.json', { hooks: { signalLearning: { enabled: false }, learnNudge: { enabled: false } } });
  put(root, 'skills/example/SKILL.md', '# Example'); put(memory, 'buckets/preferences/page.md', '# Preference');
  const event = { cwd: root, session_id: 'reads', hook_event_name: 'PostToolUse', tool_name: 'Read' };
  for (const path of [resolve(root, 'skills/example/SKILL.md'), resolve(memory, 'buckets/preferences/page.md'), resolve(root, 'README.md'), resolve(memory, 'buckets/private/facts.md')]) await handleEvent({ ...event, tool_input: { file_path: path } }, { home });
  await handleEvent({ ...event, tool_input: { file_path: 'skills/failed/SKILL.md' }, tool_response: { isError: true } }, { home });
  await handleEvent({ ...event, tool_name: 'Write', tool_input: { file_path: 'skills/write/SKILL.md' } }, { home });
  const reads = get(root, '.geppetto/reads.jsonl').trim().split('\n').map(JSON.parse);
  assert.deepEqual(reads.map(row => row.kind), ['skill', 'memory']); assert.ok(reads.every(row => row.session === 'reads' && row.ts && row.path));
  assert.doesNotMatch(JSON.stringify(reads), /private|# Preference/);
});

test('outcome audit reopens evidence recurring after a change and flags changed pages never read since it', async t => {
  const root = fixture(t), home = fixture(t), path = 'skills/lesson/SKILL.md';
  put(root, '.geppetto/signals.jsonl', rows([
    { id: 'a', key: 'redo', session: 'one', category: 'efficiency', source: 'agent', status: 'open', ts: '2026-10-01T00:00:00Z' },
    { key: 'redo', status: 'resolved', reference: 'abc', paths: [path], ts: '2026-10-02T00:00:00Z' },
    { id: 'b', key: 'redo', session: 'two', category: 'efficiency', source: 'agent', status: 'open', ts: '2026-10-03T00:00:00Z' }
  ]));
  put(root, '.geppetto/reads.jsonl', rows([{ path: resolve(root, path), kind: 'skill', ts: '2026-10-01T00:00:00Z', session: 'one' }]));
  const report = await learningAudit(root, { home });
  assert.equal(report.outcomes[0].didNotFix, true); assert.deepEqual(report.outcomes[0].neverRead, [path]);
  assert.equal((await signalArchive(root)).find(row => row.key === 'redo').status, 'open');
  put(root, '.geppetto/reads.jsonl', rows([{ path: resolve(root, path), kind: 'skill', ts: '2026-10-04T00:00:00Z', session: 'two' }]));
  assert.deepEqual((await learningAudit(root, { home })).outcomes[0].neverRead, []);
});
