import { projectDataPath } from '../skills/geppetto-adopt/scripts/project-records.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, put, get, invoke, git } from './helpers.mjs';

test('signal appends one valid redacted record per call outside versioned project files', t => {
  const cwd = fixture(t); git(cwd, ['init', '-q']);
  let r = invoke('signal.mjs', ['Failed token=hello-secret Bearer secret-value sk-or-v1-abcdefghijklmnop', '--category', 'efficiency', '--key', 'failed', '--session', 'one', '--kind', 'error', '--scope', 'build'], { cwd }); assert.equal(r.status, 0, r.stderr);
  r = invoke('signal.mjs', ['Second signal', '--category', 'efficiency', '--key', 'efficiency', '--session', 'one'], { cwd }); assert.equal(r.status, 0, r.stderr);
  const records = get(cwd, projectDataPath(cwd, 'signals.jsonl')).trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 2); assert.equal(records[0].text, 'Failed token=[REDACTED] Bearer [REDACTED] [REDACTED]'); assert.equal(records[0].kind, 'error'); assert.equal(records[0].scope, 'build'); assert.equal(records[1].category, 'efficiency'); assert.notEqual(records[0].id, records[1].id); assert.equal(new Date(records[0].ts).toISOString(), records[0].ts);
  assert.doesNotMatch(git(cwd, ['status', '--porcelain', '--untracked-files=all']).stdout, /signals\.jsonl/);
  assert.equal(invoke('signal.mjs', ['text', '--category', 'efficiency', '--key', 'efficiency', '--session', 'one', '--kind', 'other'], { cwd }).status, 2);
});

test('signals redact quoted JSON secrets, environment keys and embedded URL credentials', t => {
  const cwd = fixture(t);
  const r = invoke('signal.mjs', ['{"api_key": "private-json"} OPENROUTER_API_KEY=private-env https://user:password@example.com', '--category', 'efficiency', '--key', 'efficiency', '--session', 'one'], { cwd }); assert.equal(r.status, 0, r.stderr);
  const record = JSON.parse(get(cwd, projectDataPath(cwd, 'signals.jsonl'))); assert.equal(record.text, '{"api_key=[REDACTED]} OPENROUTER_API_KEY=[REDACTED] https://[REDACTED]@example.com');
});

