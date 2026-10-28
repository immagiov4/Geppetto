import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixture, put, get, git, config } from './helpers.mjs';
import { runLearning } from '../skills/geppetto-adopt/scripts/learn-runner.mjs';

const jsonl = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
function setup(t) {
  const root = fixture(t), home = fixture(t), memory = resolve(home, 'memory');
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) assert.equal(git(root, args).status, 0);
  put(root, 'skills/example/SKILL.md', '# Example\n\nKeep the existing owner.\n');
  put(root, '.geppetto/config.json', { ...config(), memory: { localPath: memory } });
  assert.equal(git(root, ['add', '.']).status, 0); assert.equal(git(root, ['commit', '-qm', 'baseline']).status, 0);
  return { root, home, memory };
}

test('private reads relative to tool or session cwd skip the entire turn without executing learning', async t => {
  for (const host of ['codex', 'claude', 'nested', 'session', 'relative-cwd', 'quoted']) {
    const { root, home, memory } = setup(t), cwd = resolve(memory, 'buckets');
    const input = { [host === 'claude' ? 'command' : 'cmd']: host === 'quoted' ? 'Get-Content -Raw "private/personal facts.md"' : 'Get-Content -Raw "private/facts.md"', ...(host === 'session' ? {} : { [host === 'claude' ? 'cwd' : 'workdir']: host === 'relative-cwd' ? './' : cwd }) };
    const call = host === 'claude'
      ? { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input }] } }
      : { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify(host === 'nested' ? { code: `await tools.exec_command(${JSON.stringify(input)})` } : input) } };
    put(home, 'transcript.jsonl', jsonl([{ type: 'session_meta', payload: { cwd: ['session', 'relative-cwd'].includes(host) ? cwd : root } }, { type: 'user', message: { content: 'No, fix this.' } }, call, { type: 'assistant', message: { content: 'A paraphrase with no private path.' } }]));
    put(root, '.geppetto/signals.jsonl', jsonl([{ id: 'pending', text: 'Fix the existing owner.' }]));
    const result = await runLearning(root, { home, context: { learning_qualified: true, session_id: host, transcript_path: resolve(home, 'transcript.jsonl'), cwd: root }, execute: async () => assert.fail('private turn reached execute') });
    assert.equal(result.status, 'idle'); assert.equal(result.skipped, 'private-memory');
    const event = JSON.parse(get(root, '.geppetto/hook-events.jsonl').trim());
    assert.equal(event.skipped, 'private-memory'); assert.equal(event.modelCalls, 0);
    assert.equal(existsSync(resolve(root, '.geppetto/learning.json')), false);
  }
});

test('unreadable private configuration blocks and discards proposed changes', async t => {
  const { root, home, memory } = setup(t);
  put(memory, 'buckets/private', 'Synthetic invalid bucket directory');
  put(root, '.geppetto/signals.jsonl', jsonl([{ id: 'pending', text: 'Fix the existing owner.' }]));
  const result = await runLearning(root, { home, execute: async ({ cwd }) => {
    put(cwd, 'new-lesson.md', 'A proposed correction.\n');
    return { decision: 'applied', reason: 'Retained a correction.', owner: 'new-lesson.md' };
  } });
  assert.equal(result.status, 'blocked'); assert.equal(existsSync(result.path), false);
  assert.match(result.assessment.reason, /could not be checked/); assert.equal(result.lastId, null);
});

test('learning rejects added private lines and paths before staging or committing, and removes rejected output', async t => {
  for (const untracked of [false, true]) for (const addition of ['prefix Synthetic confidential detail with spaces. suffix', 'buckets/private/facts.md', 'buckets\\private\\facts.md', 'buckets/preferences/../private/facts.md', '1234567890123456789 0', 'binary\0Synthetic confidential detail with spaces.']) {
    const { root, home, memory } = setup(t);
    assert.equal(git(root, ['config', 'color.ui', 'always']).status, 0);
    assert.equal(git(root, ['config', 'diff.outputIndicatorNew', '>']).status, 0);
    put(memory, 'buckets/private/nested/facts.md', 'Synthetic confidential detail with spaces.\n1234567890123456789 0\n');
    put(root, '.geppetto/signals.jsonl', jsonl([{ id: 'pending', text: 'Fix the existing owner.' }]));
    const before = git(root, ['rev-parse', 'HEAD']).stdout.trim();
    let output;
    const result = await runLearning(root, { home, execute: async ({ cwd }) => {
      output = cwd;
      if (untracked) put(cwd, 'new-lesson.md', addition + '\n');
      else put(cwd, 'skills/example/SKILL.md', get(cwd, 'skills/example/SKILL.md') + addition + '\n');
      return { decision: 'applied', reason: 'Retained the correction.', owner: 'skills/example/SKILL.md' };
    } });
    assert.equal(result.status, 'blocked'); assert.match(result.assessment.reason, /private/i); assert.equal(result.lastId, null);
    assert.equal(existsSync(output), false);
    assert.equal(git(root, ['rev-parse', 'HEAD']).stdout.trim(), before);
    assert.equal(get(root, 'skills/example/SKILL.md'), '# Example\n\nKeep the existing owner.\n');
    assert.equal(existsSync(resolve(root, 'new-lesson.md')), false);
    assert.ok(!get(root, '.geppetto/learning.json').includes(addition));
    assert.equal(JSON.parse(get(root, '.geppetto/hook-events.jsonl').trim()).status, 'blocked');
  }
});

test('private output is discarded even when execution fails or returns an invalid assessment', async t => {
  for (const throws of [false, true]) {
    const { root, home, memory } = setup(t);
    put(memory, 'buckets/private/facts.md', 'Synthetic confidential detail with spaces.\n');
    put(root, '.geppetto/signals.jsonl', jsonl([{ id: 'pending', text: 'Fix the existing owner.' }]));
    const result = await runLearning(root, { home, execute: async ({ cwd }) => {
      put(cwd, 'new-lesson.md', 'Synthetic confidential detail with spaces.\n');
      if (throws) throw new Error('Synthetic execution failure');
    } });
    assert.equal(result.status, 'blocked'); assert.equal(existsSync(result.path), false);
  }
});

test('public additions remain eligible when private text is unchanged or shorter than the content threshold', async t => {
  const { root, home, memory } = setup(t);
  put(memory, 'buckets/private/facts.md', 'Keep the existing owner.\nshort private\n');
  put(root, '.geppetto/signals.jsonl', jsonl([{ id: 'pending', text: 'Fix the existing owner.' }]));
  const result = await runLearning(root, { home, execute: async ({ cwd }) => {
    put(cwd, 'skills/example/SKILL.md', get(cwd, 'skills/example/SKILL.md') + 'Public correction. short private\n');
    return { decision: 'applied', reason: 'Retained a public correction.', owner: 'skills/example/SKILL.md' };
  } });
  assert.equal(result.status, 'committed');
});
