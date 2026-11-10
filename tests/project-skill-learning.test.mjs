import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, put } from './helpers.mjs';
import { learningFileTool } from '../skills/geppetto-adopt/scripts/learner-tools.mjs';


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
