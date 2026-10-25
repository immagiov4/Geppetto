import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixture, put, get, invoke, parallel, git } from './helpers.mjs';

const grant = (budget = 5, extra = '') => `[benchmark] provider=any budget_usd=${budget} per=30d scope="process experiments" expires=2099-12-31${extra}\n`;
test('zero-cost checks are read-only and explicit task consent remains confined to its recorded run', t => {
  const cwd = fixture(t); const home = fixture(t);
  let r = invoke('authz.mjs', ['check', 'memory-write', '--cost', '0'], { cwd, home });
  assert.match(r.stdout, /^ask /); assert.equal(existsSync(resolve(home, '.geppetto')), false); assert.equal(existsSync(resolve(cwd, '.geppetto')), false);
  r = invoke('authz.mjs', ['check', 'memory-write', '--cost', '0', '--task-grant', 'local migration approved in this request'], { cwd, home });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /^allow .*task-scoped/); assert.equal(existsSync(resolve(home, '.geppetto')), false);
  r = invoke('authz.mjs', ['reserve', 'memory-write', '--cost', '0', '--id', 'migration', '--task-grant', 'local migration approved in this request'], { cwd, home });
  assert.equal(r.status, 0, r.stderr); const run = JSON.parse(get(home, '.geppetto/ledger.jsonl')); assert.equal(run.taskGrant, 'local migration approved in this request'); assert.equal(run.reserved, 0);
  assert.equal(existsSync(resolve(home, '.geppetto/authorizations')), false);
  assert.match(invoke('authz.mjs', ['check', 'memory-write', '--cost', '0'], { cwd, home }).stdout, /^ask /);
  put(home, '.geppetto/ledger.jsonl.lock', 'another writer');
  assert.equal(invoke('authz.mjs', ['check', 'memory-write', '--cost', '0', '--task-grant', 'read-only check'], { cwd, home }).status, 0);
});

test('task-scoped paid consent records the maximum and still respects existing project budget restrictions', t => {
  const cwd = fixture(t); const home = fixture(t);
  put(cwd, '.geppetto/authorizations', grant('0.5'));
  assert.match(invoke('authz.mjs', ['check', 'benchmark', '--cost', '1', '--task-grant', 'single benchmark'], { cwd, home }).stdout, /^deny .*Budget/);
  let r = invoke('authz.mjs', ['reserve', 'benchmark', '--cost', '0.25', '--id', 'task-paid', '--task-grant', 'single benchmark'], { cwd, home });
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(get(home, '.geppetto/ledger.jsonl')).reserved, 250000);
  r = invoke('authz.mjs', ['reserve', 'benchmark', '--cost', '0.25', '--id', 'task-paid', '--task-grant', 'single benchmark'], { cwd, home }); assert.equal(r.status, 1);
  assert.equal(invoke('authz.mjs', ['check', 'benchmark', '--cost', '0', '--task-grant', ' '], { cwd, home }).status, 2);
});

test('explicit provider requests must match the effective grant before any reservation', t => {
  const cwd = fixture(t); const home = fixture(t); const restricted = grant().replace('provider=any', 'provider=openai');
  put(home, '.geppetto/authorizations', restricted); put(cwd, '.geppetto/authorizations', restricted);
  let r = invoke('authz.mjs', ['reserve', 'benchmark', '--provider', 'openrouter', '--cost', '0.1', '--id', 'wrong-provider'], { cwd, home });
  assert.match(r.stdout, /^deny .*provider.*outside/); assert.equal(existsSync(resolve(home, '.geppetto/ledger.jsonl')), false);
  r = invoke('authz.mjs', ['reserve', 'benchmark', '--provider', 'openai', '--cost', '0.1', '--id', 'right-provider'], { cwd, home });
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(get(home, '.geppetto/ledger.jsonl')).provider, 'openai');
});
test('project grants cannot authorize spending without a personal grant; budgets and expiry intersect', t => {
  const cwd = fixture(t); const home = fixture(t); put(cwd, '.geppetto/authorizations', grant());
  let r = invoke('authz.mjs', ['check', 'benchmark', '--cost', '1'], { cwd, home }); assert.equal(r.status, 1); assert.match(r.stdout, /^ask /);
  put(home, '.geppetto/authorizations', grant()); r = invoke('authz.mjs', ['check', 'benchmark', '--cost', '1'], { cwd, home }); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /^allow /);
  put(cwd, '.geppetto/authorizations', grant(0.5)); assert.match(invoke('authz.mjs', ['check', 'benchmark', '--cost', '1'], { cwd, home }).stdout, /^deny .*Budget/);
  put(cwd, '.geppetto/authorizations', grant().replace('2099-12-31', '2020-01-01')); assert.match(invoke('authz.mjs', ['check', 'benchmark', '--cost', '1'], { cwd, home }).stdout, /^deny .*expired/);
});

test('parallel reservations across projects share a single user budget and settlement releases the difference', async t => {
  const home = fixture(t); const a = fixture(t); const b = fixture(t);
  put(home, '.geppetto/authorizations', grant()); put(a, '.geppetto/authorizations', grant()); put(b, '.geppetto/authorizations', grant());
  const results = await Promise.all([parallel('authz.mjs', ['reserve', 'benchmark', '--cost', '3', '--id', 'run-a'], { cwd: a, home }), parallel('authz.mjs', ['reserve', 'benchmark', '--cost', '3', '--id', 'run-b'], { cwd: b, home })]);
  assert.deepEqual(results.map(r => r.status).sort(), [0, 1]); assert.match(results.find(r => r.status === 1).stdout, /^deny .*Budget/);
  const id = results[0].status === 0 ? 'run-a' : 'run-b'; const cwd = results[0].status === 0 ? a : b;
  assert.equal(invoke('authz.mjs', ['reserve', 'benchmark', '--cost', '3', '--id', id], { cwd, home }).status, 1);
  let r = invoke('authz.mjs', ['settle', '--id', id, '--actual', '0.25'], { cwd, home }); assert.equal(r.status, 0, r.stderr);
  assert.equal(invoke('authz.mjs', ['settle', '--id', id, '--actual', '0.25'], { cwd, home }).status, 0);
  assert.equal(invoke('authz.mjs', ['settle', '--id', id, '--actual', '1'], { cwd, home }).status, 1);
  r = invoke('authz.mjs', ['check', 'benchmark', '--cost', '4.75'], { cwd: b, home }); assert.equal(r.status, 0, r.stderr);
  r = invoke('authz.mjs', ['check', 'benchmark', '--cost', '4.750001'], { cwd: a, home }); assert.match(r.stdout, /^deny /);
  assert.equal(JSON.parse(invoke('authz.mjs', ['list'], { cwd, home }).stdout).ledger[0].actual, 250000);
});

test('malformed grants, a corrupt ledger, unknown settlements and invalid costs fail closed', t => {
  const cwd = fixture(t); const home = fixture(t); put(home, '.geppetto/authorizations', grant(5, ' extra=yes')); put(cwd, '.geppetto/authorizations', grant());
  assert.match(invoke('authz.mjs', ['check', 'benchmark', '--cost', '1'], { cwd, home }).stderr, /authorizations:1:/);
  put(home, '.geppetto/authorizations', grant()); put(home, '.geppetto/ledger.jsonl', '{bad}\n'); assert.match(invoke('authz.mjs', ['reserve', 'benchmark', '--cost', '1', '--id', 'x'], { cwd, home }).stderr, /Corrupt ledger/);
  assert.equal(invoke('authz.mjs', ['check', 'benchmark', '--cost', '-1'], { cwd, home }).status, 2);
  put(home, '.geppetto/ledger.jsonl', ''); assert.equal(invoke('authz.mjs', ['settle', '--id', 'missing', '--actual', '1'], { cwd, home }).status, 1);
});

test('provider restrictions must intersect, project denial wins, and abandoned reservations keep their full maximum', t => {
  const cwd = fixture(t); const home = fixture(t);
  put(home, '.geppetto/authorizations', grant().replace('provider=any', 'provider=openai'));
  put(cwd, '.geppetto/authorizations', grant().replace('provider=any', 'provider=anthropic'));
  assert.match(invoke('authz.mjs', ['check', 'benchmark', '--cost', '1'], { cwd, home }).stdout, /^deny .*provider restrictions/);
  put(cwd, '.geppetto/authorizations', ''); assert.match(invoke('authz.mjs', ['check', 'benchmark', '--cost', '1'], { cwd, home }).stdout, /^deny .*Project/);
  put(cwd, '.geppetto/authorizations', grant());
  put(home, '.geppetto/ledger.jsonl', `${JSON.stringify({ type: 'reserve', id: 'interrupted', capability: 'benchmark', project: cwd, ts: '2020-01-01T00:00:00.000Z', reserved: 5000000 })}\n`);
  assert.match(invoke('authz.mjs', ['check', 'benchmark', '--cost', '0.01'], { cwd, home }).stdout, /^deny .*Budget/);
  const r = invoke('authz.mjs', ['settle', '--id', 'interrupted', '--actual', '0.125'], { cwd, home }); assert.equal(r.status, 0, r.stderr);
  assert.equal(invoke('authz.mjs', ['check', 'benchmark', '--cost', '5'], { cwd, home }).status, 0);
});

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
