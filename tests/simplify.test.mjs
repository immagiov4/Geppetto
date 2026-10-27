import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { existsSync, symlinkSync } from 'node:fs';
import { fixture, put, get, invoke, git } from './helpers.mjs';
import { runLearning, executeLearning } from '../skills/geppetto-adopt/scripts/learn-runner.mjs';
import { learningFileTool } from '../skills/geppetto-adopt/scripts/learner-tools.mjs';
import { memorySettings } from '../skills/geppetto-adopt/scripts/memory-config.mjs';

test('two repositories reuse one machine hook set, key location, memory and maintenance jobs', t => {
  const home = fixture(t), a = fixture(t), b = fixture(t);
  const memory = resolve(home, 'memory'); put(memory, 'index.md', '# Memory'); git(memory, ['init', '-q']);
  put(home, '.geppetto/config.json', { memory: { repo: memory, localPath: memory } });
  for (const cwd of [a, b, a]) {
    const r = invoke('install.mjs', ['--target', 'codex', '--project', cwd], { cwd, home, env: { OPENROUTER_API_KEY: 'synthetic' } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(resolve(cwd, '.codex/hooks.json')), false);
  }
  const machine = JSON.parse(get(home, '.geppetto/machine.json'));
  assert.equal(Object.keys(machine.projects).length, 2);
  assert.equal(Object.keys(machine.jobs).length, 3);
  assert.equal(machine.keys.openrouter, 'OPENROUTER_API_KEY');
  assert.equal(machine.memory.repo, memory);
  const hooks = JSON.parse(get(home, '.codex/hooks.json')).hooks;
  for (const groups of Object.values(hooks)) {
    const commands = groups.flatMap(g => g.hooks.map(h => h.command));
    assert.equal(new Set(commands).size, commands.length);
  }
  machine.jobs['curate-skills'] = { ...machine.jobs['curate-skills'], id: 'existing-scheduler-job', status: 'scheduled' };
  put(home, '.geppetto/machine.json', machine);
  let result = invoke('install.mjs', ['--target', 'codex', '--project', b, '--plugin-hooks'], { cwd: b, home });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(get(home, '.geppetto/machine.json')).jobs['curate-skills'].id, 'existing-scheduler-job');
  assert.ok(Object.values(JSON.parse(get(home, '.codex/hooks.json')).hooks).every(groups => groups.length === 0), 'plugin hooks replace the shared command copy');
  result = invoke('install.mjs', ['--target', 'codex', '--project', a, '--uninstall'], { cwd: a, home });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(Object.keys(JSON.parse(get(home, '.geppetto/machine.json')).projects), [b]);
});

test('runner processes a signal snapshot on a branch, machine lock prevents overlap and failure permits retry', async t => {
  const home = fixture(t), root = fixture(t), other = fixture(t);
  git(root, ['init', '-q']); git(root, ['config', 'user.name', 'Fixture']); git(root, ['config', 'user.email', 'fixture@example.invalid']);
  put(root, 'README.md', '# Fixture\n'); git(root, ['add', '.']); git(root, ['commit', '-qm', 'baseline']);
  put(root, '.geppetto/signals.jsonl', JSON.stringify({ id: 'one', text: 'Use the existing helper', metric: 'complexity' }) + '\n');
  put(other, '.geppetto/signals.jsonl', '{"id":"other","text":"another project"}\n');
  let release, started; const active = new Promise(done => { release = done; }); const launched = new Promise(done => { started = done; }); let launches = 0;
  const execute = async ({ cwd, prompt }) => { launches++; assert.match(prompt, /untrusted evidence/); started(); await active; put(cwd, 'lesson.md', 'Use existing helpers.\n'); return { decision: 'applied', reason: 'Retained the reusable helper lesson.', owner: 'lesson.md' }; };
  const first = runLearning(root, { home, execute });
  await Promise.race([first, launched]);
  assert.equal((await runLearning(root, { home, execute })).status, 'busy');
  assert.equal((await runLearning(other, { home, execute })).status, 'busy');
  release(); const result = await first;
  assert.equal(result.status, 'committed'); assert.equal(launches, 1); assert.equal(get(root, 'README.md'), '# Fixture\n');
  assert.equal((await runLearning(root, { home, execute })).status, 'idle');
  assert.equal(existsSync(resolve(home, '.geppetto/learn.lock')), false);
  put(root, '.geppetto/signals.jsonl', get(root, '.geppetto/signals.jsonl') + JSON.stringify({ id: 'two', text: 'Fix verified dead end' }) + '\n');
  await assert.rejects(runLearning(root, { home, execute: async () => { throw new Error('fixture failure'); } }), /fixture failure/);
  assert.equal(existsSync(resolve(home, '.geppetto/learn.lock')), false);
  const retry = await runLearning(root, { home, execute: async () => ({ decision: 'no_change', reason: 'Existing procedure covers the signal.', owner: 'README.md' }) }); assert.equal(retry.status, 'unchanged');
});

test('the subscription CLI receives only file tools, with no model override or API routing', async t => {
  const cwd = fixture(t); const old = { ...process.env };
  t.after(() => { process.env = old; });
  put(cwd, 'node_modules/@openai/codex/bin/codex.js', `const fs=require('node:fs'); let prompt=''; process.stdin.on('data',d=>prompt+=d); process.stdin.on('end',()=>{const args=process.argv.slice(2);fs.writeFileSync('native.json',JSON.stringify({args,prompt,key:process.env.OPENAI_API_KEY,child:process.env.GEPPETTO_LEARNING_CHILD}));fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({decision:'no_change',reason:'Already covered.',owner:'README.md'}));});`);
  process.env.PATH = cwd; process.env.OPENAI_API_KEY = 'fixture-secret';
  assert.equal((await executeLearning({ cwd, prompt: 'Fixed synthetic learning prompt', host: 'codex', resultPath: resolve(cwd, 'result.json') })).decision, 'no_change');
  const result = JSON.parse(get(cwd, 'native.json'));
  assert.equal(result.prompt, 'Fixed synthetic learning prompt'); assert.equal(result.key, undefined); assert.equal(result.child, '1');
  assert.ok(result.args.includes('features.shell_tool=false')); assert.ok(result.args.includes('features.multi_agent=false'));
  assert.ok(result.args.includes('read-only')); assert.ok(result.args.some(arg => arg.includes('learner-tools.mjs')));
  assert.ok(result.args.every(arg => !/--model|service_tier/.test(arg)));
});

test('configured learning model and effort reach the CLI and the signal dispatcher', async t => {
  const cwd = fixture(t), home = fixture(t); const old = { ...process.env };
  t.after(() => { process.env = old; });
  put(cwd, 'node_modules/@openai/codex/bin/codex.js', `const fs=require('node:fs'),args=process.argv.slice(2);fs.writeFileSync('selection.json',JSON.stringify(args));fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({decision:'no_change',reason:'Already covered.',owner:'README.md'}));process.stdin.resume();`);
  process.env.PATH = cwd;
  await executeLearning({ cwd, prompt: 'Actual incident', host: 'codex', model: 'gpt-6.1-terra', reasoningEffort: 'medium', resultPath: resolve(cwd, 'result.json') });
  const args = JSON.parse(get(cwd, 'selection.json'));
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-6.1-terra');
  assert.ok(args.includes('model_reasoning_effort="medium"'));
  process.env = old;
  git(cwd, ['init', '-q']); git(cwd, ['config', 'user.name', 'Fixture']); git(cwd, ['config', 'user.email', 'fixture@example.invalid']);
  put(cwd, '.geppetto/config.json', { hooks: { signalLearning: { model: 'gpt-6.1-terra', reasoningEffort: 'medium' } } });
  git(cwd, ['add', '.geppetto/config.json']); git(cwd, ['commit', '-qm', 'baseline']);
  put(cwd, '.geppetto/signals.jsonl', '{"id":"model","text":"A real incident"}\n');
  let selection;
  await runLearning(cwd, { home, execute: async request => { selection = request; return { decision: 'no_change', reason: 'Existing behavior covers the signal.', owner: 'README.md' }; } });
  assert.equal(selection.model, 'gpt-6.1-terra'); assert.equal(selection.reasoningEffort, 'medium');
});

test('learner file boundary preserves edits while excluding private, secret and escaped paths', async t => {
  const root = fixture(t);
  await learningFileTool(root, 'Write', { path: 'docs/lesson.md', content: 'Use the owner.' });
  await learningFileTool(root, 'Edit', { path: 'docs/lesson.md', oldText: 'owner', newText: 'existing owner' });
  assert.equal(await learningFileTool(root, 'Read', { path: 'docs/lesson.md' }), 'Use the existing owner.');
  for (const path of ['../escape', '.env', 'buckets/private/fact.md', '.git/config']) await assert.rejects(learningFileTool(root, 'Write', { path, content: 'blocked' }), /scope/);
  await assert.rejects(learningFileTool(root, 'Write', { path: 'docs/lesson.md', content: 'blocked' }, true), /unavailable/);
  const messages = [{ id: 1, method: 'tools/list' }, { id: 2, method: 'tools/call', params: { name: 'Write', arguments: { path: 'docs/lesson.md', content: 'blocked' } } }];
  const result = invoke('learner-tools.mjs', [root, 'read-only', '["Read"]'], { cwd: root, input: messages.map(message => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n') + '\n' });
  assert.equal(result.status, 0, result.stderr); const replies = result.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(replies[0].result.tools.map(tool => tool.name), ['Read']); assert.equal(replies[1].result.isError, true);
  assert.equal(get(root, 'docs/lesson.md'), 'Use the existing owner.');
});

test('learning can read bundled procedures without writing them or reading outside either scope', async t => {
  const root = fixture(t), references = fixture(t), outside = fixture(t);
  const procedure = resolve(references, 'geppetto-learn/SKILL.md');
  put(references, 'geppetto-learn/SKILL.md', 'Read the actual procedure.');
  put(outside, 'fact.md', 'Outside scope');
  assert.equal(await learningFileTool(root, 'Read', { path: procedure }, false, references), 'Read the actual procedure.');
  for (const name of ['Write', 'Edit']) await assert.rejects(learningFileTool(root, name, { path: procedure, content: 'Changed', oldText: 'Read', newText: 'Write' }, false, references), /scope/);
  await assert.rejects(learningFileTool(root, 'Read', { path: resolve(outside, 'fact.md') }, false, references), /scope/);
  symlinkSync(outside, resolve(references, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(learningFileTool(root, 'Read', { path: resolve(references, 'linked/fact.md') }, false, references), /symbolic/);
  const messages = [{ id: 1, method: 'tools/call', params: { name: 'Read', arguments: { path: procedure } } }, { id: 2, method: 'tools/call', params: { name: 'Write', arguments: { path: procedure, content: 'Forbidden' } } }];
  const r = invoke('learner-tools.mjs', [root, 'workspace-write', '["Read","Write"]', references], { cwd: root, input: messages.map(m => JSON.stringify({ jsonrpc: '2.0', ...m })).join('\n') + '\n' });
  assert.equal(r.status, 0, r.stderr); const replies = r.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(replies[0].result.content[0].text, 'Read the actual procedure.'); assert.equal(replies[1].result.isError, true);
});

test('write approval retains a staged result and a signal appended during a run stays eligible', async t => {
  const home = fixture(t), root = fixture(t);
  git(root, ['init', '-q']); git(root, ['config', 'user.name', 'Fixture']); git(root, ['config', 'user.email', 'fixture@example.invalid']);
  put(root, 'README.md', '# Fixture\n'); git(root, ['add', '.']); git(root, ['commit', '-qm', 'baseline']);
  put(root, '.geppetto/config.json', { hooks: { signalLearning: { writeApproval: true } } });
  put(root, '.geppetto/signals.jsonl', '{"id":"one","text":"first"}\n');
  const result = await runLearning(root, { home, execute: async ({ cwd }) => {
    put(cwd, 'lesson.md', 'Verified lesson\n'); put(root, '.geppetto/signals.jsonl', get(root, '.geppetto/signals.jsonl') + '{"id":"two","text":"second"}\n'); return { decision: 'applied', reason: 'Retained the verified lesson.', owner: 'lesson.md' };
  } });
  assert.equal(result.status, 'staged'); assert.match(git(result.path, ['diff', '--cached', '--name-only']).stdout, /lesson.md/);
  let prompt; await runLearning(root, { home, execute: async request => { prompt = request.prompt; return { decision: 'no_change', reason: 'Existing owner covers the signal.', owner: 'README.md' }; } });
  assert.match(prompt, /second/); assert.doesNotMatch(prompt, /"text":"first"/);
});

test('machine memory reuse resolves project-relative paths and keeps project bucket links local', async t => {
  const home = fixture(t), a = fixture(t), b = fixture(t);
  const checkout = resolve(a, 'memory'); put(checkout, 'index.md', '# Memory'); git(checkout, ['init', '-q']);
  put(a, '.geppetto/config.json', { memory: { repo: checkout, localPath: 'memory', buckets: ['only-a'] } });
  for (const cwd of [a, b]) {
    const result = invoke('install.mjs', ['--target', 'codex', '--project', cwd], { cwd, home });
    assert.equal(result.status, 0, result.stderr);
  }
  const memory = await memorySettings(b, home);
  assert.equal(memory.localPath, resolve(a, 'memory')); assert.deepEqual(memory.buckets, []);
  assert.equal(JSON.parse(get(b, '.geppetto/config.json')).memory, undefined);
  assert.deepEqual((await memorySettings(a, home)).buckets, ['only-a']);
});
