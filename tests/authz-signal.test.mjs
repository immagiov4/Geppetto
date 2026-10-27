import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, put, get, invoke, git } from './helpers.mjs';

test('signal appends one valid redacted record per call and Git ignores it', t => {
  const cwd = fixture(t); git(cwd, ['init', '-q']);
  let r = invoke('signal.mjs', ['Failed token=hello-secret Bearer secret-value sk-or-v1-abcdefghijklmnop', '--metric', 'latency', '--kind', 'error', '--scope', 'build'], { cwd }); assert.equal(r.status, 0, r.stderr);
  r = invoke('signal.mjs', ['Second signal', '--metric', 'cost'], { cwd }); assert.equal(r.status, 0, r.stderr);
  const records = get(cwd, '.geppetto/signals.jsonl').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 2); assert.equal(records[0].text, 'Failed token=[REDACTED] Bearer [REDACTED] [REDACTED]'); assert.equal(records[0].kind, 'error'); assert.equal(records[0].scope, 'build'); assert.equal(records[1].metric, 'cost'); assert.notEqual(records[0].id, records[1].id); assert.equal(new Date(records[0].ts).toISOString(), records[0].ts);
  assert.equal(git(cwd, ['check-ignore', '.geppetto/signals.jsonl']).status, 0);
  assert.equal(invoke('signal.mjs', ['text', '--metric', 'cost', '--kind', 'other'], { cwd }).status, 2);
});

test('signals redact quoted JSON secrets, environment keys and embedded URL credentials', t => {
  const cwd = fixture(t);
  const r = invoke('signal.mjs', ['{"api_key": "private-json"} OPENROUTER_API_KEY=private-env https://user:password@example.com', '--metric', 'cost'], { cwd }); assert.equal(r.status, 0, r.stderr);
  const record = JSON.parse(get(cwd, '.geppetto/signals.jsonl')); assert.equal(record.text, '{"api_key=[REDACTED]} OPENROUTER_API_KEY=[REDACTED] https://[REDACTED]@example.com');
});

test('OpenRouter key is sufficient and an optional machine cap covers both projects', t => {
  const home = fixture(t), a = fixture(t), b = fixture(t); const env = { OPENROUTER_API_KEY: 'fixture' };
  assert.match(invoke('authz.mjs', ['check', 'skill-selector', '--cost', 'none'], { cwd: a, home, env }).stdout, /^allow/);
  assert.match(invoke('authz.mjs', ['check', 'skill-selector', '--cost', '0'], { cwd: a, home, env: { OPENROUTER_API_KEY: '' } }).stdout, /^deny/);
  put(home, '.geppetto/config.json', { api: { spendCapUsd: 1 } });
  let r = invoke('authz.mjs', ['reserve', 'skill-selector', '--cost', '0.6', '--id', 'a'], { cwd: a, home, env }); assert.equal(r.status, 0, r.stderr);
  assert.match(invoke('authz.mjs', ['reserve', 'memory-classifier', '--cost', '0.6', '--id', 'b'], { cwd: b, home, env }).stdout, /^deny/);
  assert.equal(invoke('authz.mjs', ['settle', '--id', 'a', '--actual', '0.1'], { cwd: a, home, env }).status, 0);
  assert.equal(invoke('authz.mjs', ['reserve', 'memory-classifier', '--cost', '0.6', '--id', 'b'], { cwd: b, home, env }).status, 0);
});
