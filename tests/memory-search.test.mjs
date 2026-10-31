import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

test('memory search follows relevance across buckets', () => {
  const skill = readFileSync('skills/geppetto-memory/SKILL.md', 'utf8');
  assert.match(skill, /rg <pattern>/);
  assert.doesNotMatch(skill, /requires an explicit user request/);
});
