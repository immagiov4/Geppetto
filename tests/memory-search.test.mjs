import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

test('memory search excludes the private bucket', () => {
  const skill = readFileSync('skills/geppetto-memory/SKILL.md', 'utf8');
  assert.match(skill, /rg --glob '!buckets\/private\/\*\*'/);
});
