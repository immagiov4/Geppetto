import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fixture, put, git, config, invoke } from './helpers.mjs';
import { runLearning } from '../skills/geppetto-adopt/scripts/learn-runner.mjs';
import { learningFileTool } from '../skills/geppetto-adopt/scripts/learner-tools.mjs';
import { learningEvidence } from '../skills/geppetto-adopt/scripts/learning-evidence.mjs';

test('background learning can inspect original messages and successful results without gaining external writes', async t => {
  const root = fixture(t), home = fixture(t), transcript = resolve(home, 'session.jsonl');
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) assert.equal(git(root, args).status, 0);
  put(root, 'README.md', '# Existing owner\n');
  put(root, '.geppetto/config.json', config());
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'baseline']);
  const rows = [
    { type: 'response_item', timestamp: '2026-11-01T12:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Keep the original account separate.' }] } },
    { type: 'response_item', timestamp: '2026-11-01T12:01:00Z', payload: { type: 'function_call_output', output: 'Browser check succeeded: previous session rejected. token=synthetic-secret' } },
  ];
  put(home, 'session.jsonl', rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  put(home, 'unrelated.txt', 'Outside the selected evidence.');
  put(root, '.geppetto/signals.jsonl', JSON.stringify({ id: 'correction', key: 'handoff', session: 'fixture', source: 'user', category: 'workflow', status: 'open', text: 'Check the handoff.', transcript_path: transcript }) + '\n');
  const result = await runLearning(root, { home, execute: async ({ cwd, evidenceRoot, prompt }) => {
    assert.ok(evidenceRoot, 'the learner needs a readable evidence directory');
    const tools = { evidenceRoot };
    const read = path => learningFileTool(cwd, 'Read', { path }, false, null, tools);
    const index = JSON.parse(await read(resolve(evidenceRoot, 'index.json')));
    assert.ok(prompt.includes(resolve(evidenceRoot, 'index.json')));
    const text = (await Promise.all(index.pages.map(page => read(page.path)))).join('');
    assert.match(text, /Keep the original account separate/);
    assert.match(text, /Browser check succeeded/);
    assert.doesNotMatch(text, /synthetic-secret/);
    assert.deepEqual(JSON.parse(await read(index.config)), config());
    await assert.rejects(learningFileTool(cwd, 'Write', { path: index.config, content: '{}' }, false, null, tools));
    await assert.rejects(read(resolve(home, 'unrelated.txt')));
    await assert.rejects(read('.geppetto/config.json'));
    return { decision: 'no_change', owner: 'README.md', reason: 'The existing owner covers the observed handoff.' };
  } });
  assert.equal(result.status, 'unchanged');
});

test('evidence pages keep Unicode and complete records, redact config and report missing sessions', async t => {
  const root = fixture(t), evidenceRoot = resolve(root, 'evidence'), transcript = resolve(root, 'session.jsonl');
  const original = '🙂'.repeat(15000) + ' complete tail';
  const row = { type: 'response_item', payload: { type: 'function_call_output', output: original } };
  put(root, 'session.jsonl', JSON.stringify(row) + '\n' + '{"partial":');
  await learningEvidence(evidenceRoot, [transcript, transcript, resolve(root, 'missing.jsonl')], { apiKey: 'synthetic-secret', foundations: { documentation: 'README' } });
  const read = path => learningFileTool(root, 'Read', { path }, false, null, { evidenceRoot });
  const index = JSON.parse(await read(resolve(evidenceRoot, 'index.json')));
  assert.equal(index.records, 1); assert.equal(index.unavailable.length, 1);
  assert.ok(index.pages.length > 1); assert.ok(index.pages.every(page => page.characters <= 24000));
  const output = (await Promise.all(index.pages.map(page => read(page.path)))).join('');
  assert.equal(JSON.parse(output).output, original);
  assert.deepEqual(JSON.parse(await read(index.config)), { apiKey: '[REDACTED]', foundations: { documentation: 'README' } });
  await assert.rejects(learningFileTool(root, 'Write', { path: index.pages[0].path, content: 'overwrite' }, false, null, { evidenceRoot }));
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'Read', arguments: { path: index.config } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'Write', arguments: { path: index.config, content: '{}' } } },
  ];
  const response = invoke('learner-tools.mjs', [root, 'workspace-write', '["Read","Write"]', resolve('skills'), root, 'fixture', evidenceRoot], { input: requests.map(row => JSON.stringify(row)).join('\n') + '\n' });
  assert.equal(response.status, 0, response.stderr);
  const replies = response.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(JSON.parse(replies[0].result.content[0].text).apiKey, '[REDACTED]');
  assert.equal(replies[1].result.isError, true);
});

test('quoted transcript secrets and structured credentials are removed as complete values', async t => {
  const root = fixture(t), evidenceRoot = resolve(root, 'evidence');
  const output = 'password="alpha beta gamma"\npassword="first\nsecond"';
  put(root, 'session.jsonl', JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output, apiKey: 'embedded;credential' } }) + '\n');
  await learningEvidence(evidenceRoot, [resolve(root, 'session.jsonl')], { password: 'alpha beta gamma', apiKey: 'first;second', normal: 'Retain the ordinary setting.' });
  const read = path => learningFileTool(root, 'Read', { path }, false, null, { evidenceRoot });
  const index = JSON.parse(await read(resolve(evidenceRoot, 'index.json')));
  const evidence = (await Promise.all(index.pages.map(page => read(page.path)))).join('');
  assert.doesNotMatch(evidence, /alpha|beta|gamma|first|second|embedded|credential/);
  assert.deepEqual(JSON.parse(await read(index.config)), { password: '[REDACTED]', apiKey: '[REDACTED]', normal: 'Retain the ordinary setting.' });
});
