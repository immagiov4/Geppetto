import { projectDataPath } from '../skills/geppetto-adopt/scripts/project-records.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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

test('private reads relative to tool or session cwd skip the entire turn without executing learning', async t => {
  for (const host of ['codex', 'claude', 'nested', 'session', 'relative-cwd', 'quoted']) {
    const { root, home, memory } = setup(t), cwd = resolve(memory, 'buckets');
    const input = { [host === 'claude' ? 'command' : 'cmd']: host === 'quoted' ? 'Get-Content -Raw "private/personal facts.md"' : 'Get-Content -Raw "private/facts.md"', ...(host === 'session' ? {} : { [host === 'claude' ? 'cwd' : 'workdir']: host === 'relative-cwd' ? './' : cwd }) };
    const call = host === 'claude'
      ? { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input }] } }
      : { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify(host === 'nested' ? { code: `await tools.exec_command(${JSON.stringify(input)})` } : input) } };
    put(home, 'transcript.jsonl', jsonl([{ type: 'session_meta', payload: { cwd: ['session', 'relative-cwd'].includes(host) ? cwd : root } }, { type: 'user', message: { content: 'No, fix this.' } }, call, { type: 'assistant', message: { content: 'A paraphrase with no private path.' } }]));
    put(root, '.geppetto/signals.jsonl', jsonl([{ id: 'pending', key: 'pending', session: 'fixture', source: 'user', category: 'workflow', status: 'open', text: 'Fix the existing owner.' }]));
    const result = await runLearning(root, { home, context: { learning_qualified: true, session_id: host, transcript_path: resolve(home, 'transcript.jsonl'), cwd: root }, execute: async () => assert.fail('private turn reached execute') });
    assert.equal(result.status, 'idle'); assert.equal(result.skipped, 'private-memory');
    const event = JSON.parse(get(root, projectDataPath(root, 'hook-events.jsonl')).trim());
    assert.equal(event.skipped, 'private-memory'); assert.equal(event.modelCalls, 0);
    assert.equal(existsSync(projectDataPath(root, 'learning.json')), false);
  }
});

test('unreadable private configuration blocks and discards proposed changes', async t => {
  const { root, home, memory } = setup(t);
  put(memory, 'buckets/private', 'Synthetic invalid bucket directory');
  put(root, '.geppetto/signals.jsonl', jsonl([{ id: 'pending', key: 'pending', session: 'fixture', source: 'user', category: 'workflow', status: 'open', text: 'Fix the existing owner.' }]));
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
    put(root, '.geppetto/signals.jsonl', jsonl([{ id: 'pending', key: 'pending', session: 'fixture', source: 'user', category: 'workflow', status: 'open', text: 'Fix the existing owner.' }]));
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
    assert.ok(!get(root, projectDataPath(root, 'learning.json')).includes(addition));
    assert.equal(JSON.parse(get(root, projectDataPath(root, 'hook-events.jsonl')).trim()).status, 'blocked');
  }
});

test('private output is discarded even when execution fails or returns an invalid assessment', async t => {
  for (const throws of [false, true]) {
    const { root, home, memory } = setup(t);
    put(memory, 'buckets/private/facts.md', 'Synthetic confidential detail with spaces.\n');
    put(root, '.geppetto/signals.jsonl', jsonl([{ id: 'pending', key: 'pending', session: 'fixture', source: 'user', category: 'workflow', status: 'open', text: 'Fix the existing owner.' }]));
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
  put(root, '.geppetto/signals.jsonl', jsonl([{ id: 'pending', key: 'pending', session: 'fixture', source: 'user', category: 'workflow', status: 'open', text: 'Fix the existing owner.' }]));
  const result = await runLearning(root, { home, execute: async ({ cwd }) => {
    put(cwd, 'skills/example/SKILL.md', get(cwd, 'skills/example/SKILL.md') + 'Public correction. short private\n');
    return { decision: 'applied', reason: 'Retained a public correction.', owner: 'skills/example/SKILL.md' };
  } });
  assert.equal(result.status, 'committed');
});

test('private junctions and encoded file URIs exclude complete Codex and Claude sessions', async t => {
  for (const host of ['codex', 'claude']) for (const route of ['junction', 'encoded-uri', 'memory-junction']) await t.test(`${host}: ${route}`, async t => {
    const { root, home, memory } = setup(t);
    const secret = 'SYNTHETIC confidential appointment is Tuesday at the blue observatory.';
    put(memory, 'buckets/private/personal facts.md', secret + '\n');
    let name, input, actual;
    if (route === 'encoded-uri') {
      const uri = pathToFileURL(resolve(memory, 'buckets/private/personal facts.md')).href.replace('/private/', '/p%72ivate/');
      name = 'mcp__filesystem__read_file'; input = { path: uri }; actual = readFileSync(new URL(uri), 'utf8');
    } else {
      let path;
      if (route === 'junction') {
        symlinkSync(resolve(memory, 'buckets/private'), resolve(root, 'linked-notes'), 'junction');
        path = 'linked-notes/personal facts.md';
      } else {
        const alias = resolve(home, 'memory-alias'); symlinkSync(memory, alias, 'junction');
        put(root, '.geppetto/config.json', { ...config(), memory: { localPath: alias } });
        symlinkSync(resolve(memory, 'buckets/private'), resolve(root, 'linked-notes'), 'junction');
        path = 'linked-notes/personal facts.md';
      }
      name = host === 'claude' ? 'Bash' : 'exec_command';
      input = host === 'claude' ? { command: `Get-Content -Raw "${path}"`, cwd: root } : { cmd: `Get-Content -Raw "${path}"`, workdir: root };
      actual = get(root, path);
    }
    assert.equal(actual.trim(), secret);
    const call = host === 'claude'
      ? { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'read', name, input }] } }
      : { type: 'response_item', payload: { type: 'function_call', call_id: 'read', name, arguments: JSON.stringify(input) } };
    const output = host === 'claude'
      ? { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: actual }] } }
      : { type: 'response_item', payload: { type: 'function_call_output', call_id: 'read', output: actual } };
    put(home, 'transcript.jsonl', jsonl([{ type: 'session_meta', payload: { cwd: root } }, { type: 'user', message: { content: 'No, fix the owner.' } }, call, output, { type: 'assistant', message: { content: actual } }]));
    let calls = 0;
    const result = await runLearning(root, { home, context: { learning_qualified: true, session_id: `${host}-${route}`, transcript_path: resolve(home, 'transcript.jsonl'), cwd: root }, execute: async () => {
      calls++; return { decision: 'no_change', reason: 'Already covered.', owner: 'skills/example/SKILL.md' };
    } });
    assert.equal(calls, 0); assert.equal(result.skipped, 'private-memory'); assert.equal(result.status, 'idle');
    assert.equal(JSON.parse(get(root, projectDataPath(root, 'hook-events.jsonl')).trim()).modelCalls, 0);
  });
});

test('git show revision paths in the memory repository exclude learning even after the file is gone', async t => {
  const { root, home, memory } = setup(t);
  const secret = 'Synthetic private history belongs only in the memory repository.';
  put(memory, 'buckets/private/facts.md', secret + '\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'private fixture'], ['rm', 'buckets/private/facts.md']]) assert.equal(git(memory, args).status, 0);
  const command = 'git show HEAD:buckets/private/facts.md';
  assert.equal(git(memory, ['show', 'HEAD:buckets/private/facts.md']).stdout.trim(), secret);
  put(home, 'transcript.jsonl', jsonl([{ type: 'user', message: { content: 'No, fix this.' } }, { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: command, workdir: memory }) } }, { type: 'assistant', message: { content: secret } }]));
  const result = await runLearning(root, { home, context: { learning_qualified: true, session_id: 'git-show', transcript_path: resolve(home, 'transcript.jsonl'), cwd: root }, execute: async () => assert.fail('private revision reached execute') });
  assert.equal(result.skipped, 'private-memory');
});

test('normalized private text is blocked across added lines in tracked and new files', async t => {
  for (const untracked of [false, true]) for (const variant of ['split', 'case', 'whitespace']) await t.test(`${untracked ? 'new' : 'tracked'}: ${variant}`, async t => {
    const { root, home, memory } = setup(t);
    const secret = 'SYNTHETIC confidential appointment is Tuesday at the blue observatory.';
    put(memory, 'buckets/private/facts.md', variant === 'whitespace' ? secret.replaceAll(' ', '\t  ') + '\r\n' : secret + '\n');
    put(root, '.geppetto/signals.jsonl', jsonl([{ id: 'pending', key: 'pending', session: 'fixture', source: 'user', category: 'workflow', status: 'open', text: 'Fix the existing owner.' }]));
    const addition = variant === 'split' ? secret.replace('at the', 'at\nthe') : variant === 'case' ? secret.toLowerCase() : secret.toLowerCase().replaceAll(' ', '  \t');
    const target = untracked ? 'lessons/public.md' : 'skills/example/SKILL.md';
    const result = await runLearning(root, { home, execute: async ({ cwd }) => {
      await learningFileTool(cwd, 'Write', { path: target, content: (untracked ? '' : get(cwd, target)) + addition + '\n' });
      return { decision: 'applied', reason: 'Retained a correction.', owner: target };
    } });
    assert.equal(result.status, 'blocked'); assert.equal(result.lastId, null); assert.equal(existsSync(result.path), false);
    assert.match(result.assessment.reason, /private/);
    assert.equal(git(root, ['branch', '--list', result.branch]).stdout.trim(), '');
    assert.ok(!get(root, projectDataPath(root, 'learning.json')).includes('observatory'));
  });
});

test('normalized private text is checked across separate diff hunks and new files', async t => {
  for (const acrossFiles of [false, true]) await t.test(acrossFiles ? 'separate files' : 'separate hunks', async t => {
    const { root, home, memory } = setup(t), target = 'skills/example/SKILL.md';
    put(memory, 'buckets/private/facts.md', 'Synthetic confidential appointment is Tuesday.\n');
    put(root, target, 'first\nunchanged\nlast\n');
    put(root, '.geppetto/signals.jsonl', jsonl([{ id: 'pending', key: 'pending', session: 'fixture', source: 'user', category: 'workflow', status: 'open', text: 'Fix the existing owner.' }]));
    const result = await runLearning(root, { home, execute: async ({ cwd }) => {
      await learningFileTool(cwd, 'Write', { path: target, content: 'first\nSYNTHETIC confidential\nunchanged\nlast\n' + (acrossFiles ? '' : 'appointment is Tuesday.\n') });
      if (acrossFiles) await learningFileTool(cwd, 'Write', { path: 'lessons/public.md', content: 'appointment is Tuesday.\n' });
      return { decision: 'applied', reason: 'Retained a correction.', owner: target };
    } });
    assert.equal(result.status, 'blocked'); assert.equal(existsSync(result.path), false); assert.equal(result.lastId, null);
  });
});

test('removed private files retain lexical provenance matching', async t => {
  const { root, home, memory } = setup(t), cwd = resolve(memory, 'buckets');
  put(memory, 'buckets/private/other.md', 'Synthetic remaining private text.\n');
  assert.equal(existsSync(resolve(cwd, 'private/gone.md')), false);
  put(home, 'transcript.jsonl', jsonl([{ type: 'session_meta', payload: { cwd } }, { type: 'user', message: { content: 'No, fix this.' } }, { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'cat private/gone.md', workdir: cwd }) } }]));
  const result = await runLearning(root, { home, context: { learning_qualified: true, session_id: 'removed-file', transcript_path: resolve(home, 'transcript.jsonl'), cwd: root }, execute: async () => assert.fail('removed private path reached execute') });
  assert.equal(result.skipped, 'private-memory');
});

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
