import { projectDataPath } from '../skills/geppetto-adopt/scripts/project-records.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fixture, put, get, git, config } from './helpers.mjs';
import { runLearning } from '../skills/geppetto-adopt/scripts/learn-runner.mjs';
import { learningFileTool } from '../skills/geppetto-adopt/scripts/learner-tools.mjs';

const jsonl = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
function setup(t) {
  const root = fixture(t), home = fixture(t), memory = resolve(home, 'memory');
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) assert.equal(git(root, args).status, 0);
  put(root, 'skills/example/SKILL.md', '# Example\n\nKeep the existing owner.\n');
  put(root, '.geppetto/config.json', { ...config(), memory: { localPath: memory } });
  assert.equal(git(root, ['add', '.']).status, 0); assert.equal(git(root, ['commit', '-qm', 'baseline']).status, 0);
  return { root, home, memory };
}

test('large public learning changes commit their complete content beyond the default diff buffer', async t => {
  const { root, home, memory } = setup(t), target = 'skills/example/SKILL.md';
  put(memory, 'buckets/private/facts.md', 'Synthetic confidential detail with spaces.\n');
  put(root, '.geppetto/signals.jsonl', jsonl([{ id: 'pending', key: 'pending', session: 'fixture', source: 'user', category: 'workflow', status: 'open', text: 'Fix the existing owner.' }]));
  const content = get(root, target) + 'A public correction with no private data.\n'.repeat(40000);
  const result = await runLearning(root, { home, execute: async ({ cwd }) => {
    await learningFileTool(cwd, 'Write', { path: target, content });
    return { decision: 'applied', reason: 'Retained a public correction.', owner: target };
  } });
  assert.equal(result.status, 'committed'); assert.equal(result.lastId, 'pending');
  const retained = git(result.path, ['show', `HEAD:${target}`], { maxBuffer: Infinity });
  assert.equal(retained.status, 0, retained.stderr); assert.equal(retained.stdout, content);
  const diff = git(result.path, ['diff', '--text', '--unified=0', result.baseline, 'HEAD', '--'], { maxBuffer: Infinity });
  assert.equal(diff.status, 0, diff.stderr); assert.ok(Buffer.byteLength(diff.stdout) > 1700000);
  assert.equal(get(root, target), '# Example\n\nKeep the existing owner.\n');
});



test('personal bucket evidence remains eligible and can produce a retained improvement', async t => {
  const { root, home, memory } = setup(t), fact = 'Synthetic personal preference: keep the explanation concrete.';
  put(memory, 'buckets/private/facts.md', fact);
  put(home, 'chat.jsonl', jsonl([
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'cat buckets/private/facts.md', workdir: memory }) } },
    { type: 'user', message: { content: 'No, remember this preference: ' + fact } }
  ]));
  put(root, '.geppetto/signals.jsonl', jsonl([{ id: 'personal', key: 'personal', session: 'fixture', source: 'user', sourcePrivacy: 'private', category: 'workflow', status: 'open', text: fact }]));
  let prompt;
  const result = await runLearning(root, { home, context: { learning_qualified: true, session_id: 'personal', transcript_path: resolve(home, 'chat.jsonl') }, execute: async request => {
    prompt = request.prompt;
    await learningFileTool(request.cwd, 'Write', { path: 'buckets/private/preference.md', content: fact });
    return { decision: 'applied', reason: 'Retained the authorized personal preference.', owner: 'buckets/private/preference.md' };
  } });
  assert.equal(result.status, 'committed');
  assert.ok(prompt.includes(fact));
  assert.equal(get(result.path, 'buckets/private/preference.md'), fact);
  assert.equal(result.lastId, 'personal');
});
