import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, put, get, git } from './helpers.mjs';
import { learningFileTool } from '../skills/geppetto-adopt/scripts/learner-tools.mjs';
import { runLearning } from '../skills/geppetto-adopt/scripts/learn-runner.mjs';

test('local skill access preserves runtime settings and credential boundaries', async t => {
  const root = fixture(t);
  for (const path of ['.agents/settings.json', '.claude/settings.json', '.codex/config.toml', '.geppetto/config.json', '.agents/skills/example/.env', '.agents/skills/example/key.pem']) {
    put(root, path, '{}');
    await assert.rejects(learningFileTool(root, 'Read', { path }), /outside the learning scope/);
    await assert.rejects(learningFileTool(root, 'Write', { path, content: 'overwrite' }), /outside the learning scope/);
  }
  put(root, '.claude/skills/example/SKILL.md', '# Local Claude skill');
  assert.equal(await learningFileTool(root, 'Read', { path: '.claude/skills/example/SKILL.md' }), '# Local Claude skill');
});

test('learning retains a correction at an installed project skill without modifying the source checkout', async t => {
  const root = fixture(t), home = fixture(t);
  const target = '.agents/skills/project-procedure/SKILL.md';
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) assert.equal(git(root, args).status, 0);
  put(root, target, '# Procedure\nCheck the result.\n');
  assert.equal(git(root, ['add', '.']).status, 0);
  assert.equal(git(root, ['commit', '-qm', 'baseline']).status, 0);
  put(root, '.geppetto/signals.jsonl', JSON.stringify({ id: 'local', key: 'local', session: 'fixture', source: 'user', category: 'workflow', status: 'open', text: 'Check the failed-file replacement before delivery.' }) + '\n');
  const result = await runLearning(root, { home, execute: async ({ cwd }) => {
    const files = await learningFileTool(cwd, 'Glob', {});
    assert.ok(files.includes(target));
    const original = await learningFileTool(cwd, 'Read', { path: target });
    await learningFileTool(cwd, 'Write', { path: target, content: original + 'Exercise replacement after a failed upload.\n' });
    return { decision: 'applied', reason: 'Evidence: local. Preserve the demonstrated recovery check.', owner: target };
  } });
  assert.equal(result.status, 'committed');
  assert.match(get(result.path, target), /Exercise replacement/);
  assert.equal(get(root, target), '# Procedure\nCheck the result.\n');
  assert.equal(git(result.path, ['diff', '--name-only', result.baseline, 'HEAD']).stdout.trim(), target);
});
