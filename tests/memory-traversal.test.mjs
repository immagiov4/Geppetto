import { test } from 'node:test';
import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixture, put, get, git, config } from './helpers.mjs';
import { classifyMemory } from '../skills/geppetto-adopt/scripts/memory-classifier.mjs';
const runClassifier = (event, options) => classifyMemory(event, { project: event.cwd, ...options });
import { openRouterClassify } from '../skills/geppetto-adopt/scripts/memory-provider.mjs';
import { candidateClassifier } from '../skills/geppetto-adopt/scripts/memory-traversal.mjs';

function setup(t, options = {}) {
  const cwd = fixture(t); const home = fixture(t); const memory = fixture(t); git(memory, ['init', '-q']);
  put(memory, 'index.md', '| Bucket | Scope | Holds |\n|---|---|---|\n| app | project | Application knowledge |\n');
  const settings = { enabled: true, benchmark: null, model: 'owner/model', bucketThreshold: 0.5, pageThreshold: 0.5, timeoutMs: 2000, maxOutputTokens: 256, maxCostUsd: 0.1, maxConcurrentRequests: 2, ...options };
  put(cwd, '.geppetto/config.json', { ...config(), memory: { repo: 'https://example.invalid/memory', localPath: memory, buckets: ['app'] }, hooks: { memoryClassifier: settings } });
  const spending = [];
  const run = provider => runClassifier({ cwd, hook_event_name: 'UserPromptSubmit', prompt: 'Find the application facts.' }, { home, provider, authorization: { reserve: async (...args) => spending.push(['reserve', ...args]), settle: async (...args) => spending.push(['settle', ...args]) }, env: { OPENROUTER_API_KEY: 'fixture' } });
  return { cwd, memory, spending, run };
}
const selected = candidates => ({ selections: candidates.map(c => ({ id: c.id, score: 1, reason: 'Relevant fact.' })), costUsd: 0.001 });

test('selected sibling indexes run concurrently, recurse to pages and stop cycles', async t => {
  const { cwd, memory, spending, run } = setup(t);
  put(memory, 'buckets/app/index.md', '[A](a/) — Branch A\n[C](c/index.md) — Branch C\n[Unused](unused/index.md) — Irrelevant\n');
  put(memory, 'buckets/app/a/index.md', '[Deep](deep/index.md) — Deep facts\n[Back](../index.md) — Parent\n');
  put(memory, 'buckets/app/a/deep/index.md', '[Fact](fact.md) — Deep fact\n[Shared](../../c/fact.md) — Shared fact\n');
  put(memory, 'buckets/app/a/deep/fact.md', 'PAGE CONTENT MUST STAY LOCAL');
  put(memory, 'buckets/app/c/index.md', '[Fact](fact.md) — C fact\n');
  put(memory, 'buckets/app/c/fact.md', 'PAGE CONTENT MUST STAY LOCAL');
  put(memory, 'buckets/app/unused/index.md', '[Broken](missing.md) — This branch must remain unread\n');
  let active = 0; let peak = 0; let release;
  const siblings = new Promise(resolve => { release = resolve; });
  const requests = [];
  const result = await run(async request => {
    requests.push(request);
    const ids = request.candidates.map(c => c.id);
    if (ids.includes('buckets/app/a/deep/index.md') || ids.length === 1 && ids[0] === 'buckets/app/c/fact.md') {
      active++; peak = Math.max(peak, active); if (active === 2) release();
      await siblings; active--;
    }
    return selected(request.candidates.filter(c => !c.id.includes('/unused/')));
  });
  assert.equal(peak, 2);
  assert.equal(result.hookSpecificOutput.additionalContext, 'You may want to check out:\n- buckets/app/a/deep/fact.md — Relevant fact.\n- buckets/app/c/fact.md — Relevant fact.');
  assert.doesNotMatch(JSON.stringify(requests), /PAGE CONTENT|missing.md/);
  assert.equal(requests.length, 5);
  assert.equal(spending.filter(e => e[0] === 'reserve').length, 1);
  assert.equal(spending.find(e => e[0] === 'settle')[2], 0.005);
  assert.equal(JSON.parse(get(cwd, '.geppetto/hook-events.jsonl')).modelCalls, 5);
});

test('large indexes split into requests below the actual serialized JSON byte budget', async t => {
  const limit = 1600;
  const { memory, run } = setup(t, { maxRequestBytes: limit });
  const names = Array.from({ length: 12 }, (_, i) => `fact-${i}.md`);
  put(memory, 'buckets/app/index.md', names.map(name => `[${name}](${name}) — ${'Description '.repeat(10)}`).join('\n'));
  for (const name of names) put(memory, `buckets/app/${name}`, 'LOCAL ONLY');
  const bodies = [];
  const result = await run(request => openRouterClassify(request, { fetchImpl: async (_url, options) => {
    bodies.push(options.body); assert.ok(Buffer.byteLength(options.body) <= limit);
    const body = JSON.parse(options.body); const input = JSON.parse(body.messages[1].content);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(selected(input.candidates)) } }], usage: { cost: 0.001 } }) };
  } }));
  assert.ok(bodies.length > 2, 'one bucket request plus multiple page batches');
  const lines = result.hookSpecificOutput.additionalContext.split('\n').slice(1);
  assert.equal(lines.length, names.length);
  for (const name of names) assert.ok(lines.some(line => line.includes(`/app/${name} —`)));
});

test('typed memory decisions recurse and split by their actual body while preserving an explicit model override', async t => {
  const limit = 1500;
  const { memory, run } = setup(t, { model: 'owner/decision-model', api: 'decisions', maxRequestBytes: limit });
  const names = Array.from({ length: 6 }, (_, index) => `page-${index}.md`);
  put(memory, 'buckets/app/index.md', names.map(name => `[${name}](${name}) — ${'Memory description '.repeat(6)}`).join('\n'));
  for (const name of names) put(memory, `buckets/app/${name}`, 'BODY STAYS LOCAL');
  let calls = 0;
  const result = await run(request => openRouterClassify(request, { fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://openrouter.ai/api/alpha/decisions'); assert.ok(Buffer.byteLength(options.body) <= limit);
    assert.ok(!options.body.includes('BODY STAYS LOCAL'));
    const body = JSON.parse(options.body); assert.equal(body.model, 'owner/decision-model'); assert.ok(body.state.message);
    return { ok: true, json: async () => ({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { noul: 0.9 }])), usage: { cost: 0.001 } }) };
  } }));
  assert.ok(calls > 2); assert.equal(result.hookSpecificOutput.additionalContext.split('\n').length, names.length + 1);
});

test('an indivisible oversized request fails before calling the provider', async t => {
  const { cwd, memory, run, spending } = setup(t, { maxRequestBytes: 32 });
  put(memory, 'buckets/app/index.md', '[Fact](fact.md)'); put(memory, 'buckets/app/fact.md', 'x');
  let calls = 0;
  const result = await run(async request => { calls++; return selected(request.candidates); });
  assert.deepEqual(result, {}); assert.equal(calls, 0);
  const log = JSON.parse(get(cwd, '.geppetto/hook-events.jsonl'));
  assert.equal(log.status, 'error'); assert.match(log.error, /request.*budget|budget.*request/i);
  assert.equal(spending.find(e => e[0] === 'settle')[2], 0);
});

test('linked index symlinks cannot cross a bucket boundary', async t => {
  const { cwd, memory, run } = setup(t);
  put(memory, 'buckets/private/index.md', '[Secret](secret.md) — PRIVATE');
  put(memory, 'buckets/app/index.md', '[Alias](alias/index.md) — Facts');
  symlinkSync(resolve(memory, 'buckets/private'), resolve(memory, 'buckets/app/alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const requests = [];
  assert.deepEqual(await run(async request => { requests.push(request); return selected(request.candidates); }), {});
  assert.doesNotMatch(JSON.stringify(requests), /PRIVATE|secret.md/);
  assert.match(JSON.parse(get(cwd, '.geppetto/hook-events.jsonl')).error, /outside|boundary|owner/i);
});

test('timeout cancels queued branches and retains unknown in-flight charges', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { cwd, memory, run, spending } = setup(t, { timeoutMs: 50 });
  put(memory, 'buckets/app/index.md', Array.from({ length: 5 }, (_, i) => `[Branch ${i}](b${i}/index.md)`).join('\n'));
  for (let i = 0; i < 5; i++) { put(memory, `buckets/app/b${i}/index.md`, '[Fact](fact.md)'); put(memory, `buckets/app/b${i}/fact.md`, 'x'); }
  let calls = 0, ready;
  const started = new Promise(done => { ready = done; });
  const pending = run(async request => {
    calls++;
    if (calls <= 2) return selected(request.candidates);
    return new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      if (calls === 4) ready();
    });
  });
  await started;
  t.mock.timers.tick(50);
  const result = await pending;
  assert.deepEqual(result, {}); assert.equal(calls, 4);
  assert.equal(spending.length, 1);
  const log = JSON.parse(get(cwd, '.geppetto/hook-events.jsonl'));
  assert.equal(log.costUsd, null); assert.match(log.error, /timed out/);
});


test('bucket catalogs are batched too and every selected bucket remains reachable', async t => {
  const limit = 1800;
  const { memory, run } = setup(t, { maxRequestBytes: limit });
  const buckets = Array.from({ length: 9 }, (_, i) => `global-${i}`);
  put(memory, 'index.md', '| Bucket | Scope | Holds |\n|---|---|---|\n' + buckets.map(bucket => `| ${bucket} | global | ${'Topic description '.repeat(7)} |`).join('\n'));
  for (const bucket of buckets) { put(memory, `buckets/${bucket}/index.md`, '[Fact](fact.md)'); put(memory, `buckets/${bucket}/fact.md`, 'x'); }
  const bucketRequests = [];
  const result = await run(request => openRouterClassify(request, { fetchImpl: async (_url, options) => {
    assert.ok(Buffer.byteLength(options.body) <= limit);
    const body = JSON.parse(options.body); const input = JSON.parse(body.messages[1].content);
    if (request.stage === 'buckets') bucketRequests.push(input.candidates);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(selected(input.candidates)) } }], usage: { cost: 0.001 } }) };
  } }));
  assert.ok(bucketRequests.length > 1);
  assert.equal(result.hookSpecificOutput.additionalContext.split('\n').length, buckets.length + 1);
});

test('one unknown concurrent charge preserves the reservation regardless of completion order', async t => {
  for (const unknownFirst of [true, false]) {
    const { cwd, memory, run, spending } = setup(t);
    put(memory, 'buckets/app/index.md', '[A](a/index.md)\n[B](b/index.md)');
    for (const branch of ['a', 'b']) { put(memory, `buckets/app/${branch}/index.md`, '[Fact](fact.md)'); put(memory, `buckets/app/${branch}/fact.md`, 'x'); }
    let count = 0; let finishFirst;
    const firstFinished = new Promise(resolve => { finishFirst = resolve; });
    const result = await run(async request => {
      count++;
      if (count <= 2) return selected(request.candidates);
      const unknown = request.candidates[0].id.includes('/a/');
      if (unknown === unknownFirst) finishFirst(); else await firstFinished;
      return { ...selected(request.candidates), costUsd: unknown ? null : 0.007 };
    });
    assert.ok(result.hookSpecificOutput.additionalContext.includes('/a/fact.md'));
    assert.equal(spending.length, 1);
    assert.equal(JSON.parse(get(cwd, '.geppetto/hook-events.jsonl')).costUsd, null);
  }
});

test('invalid request and concurrency limits fail before authorization or provider calls', async t => {
  for (const options of [{ maxRequestBytes: 0 }, { maxConcurrentRequests: 0 }, { maxConcurrentRequests: 1.5 }]) {
    const { cwd, memory, run, spending } = setup(t, options);
    put(memory, 'buckets/app/index.md', '');
    let count = 0;
    assert.deepEqual(await run(async request => { count++; return selected(request.candidates); }), {});
    assert.equal(count, 0); assert.equal(spending.length, 0);
    assert.match(JSON.parse(get(cwd, '.geppetto/hook-events.jsonl')).error, /positive integer/);
  }
});


test('a same-bucket alias to an index expands using its canonical location', async t => {
  const { memory, run } = setup(t);
  put(memory, 'buckets/app/index.md', '[Topic](alias.md)');
  put(memory, 'buckets/app/topic/index.md', '[Fact](fact.md)'); put(memory, 'buckets/app/topic/fact.md', 'x');
  symlinkSync(resolve(memory, 'buckets/app/topic/index.md'), resolve(memory, 'buckets/app/alias.md'), 'file');
  const result = await run(async request => selected(request.candidates));
  assert.equal(result.hookSpecificOutput.additionalContext, 'You may want to check out:\n- buckets/app/topic/fact.md — Relevant fact.');
});

test('a bucket root index cannot alias a terminal page', async t => {
  const { cwd, memory, run } = setup(t);
  put(memory, 'buckets/app/notes.md', '[Fact](fact.md) — TERMINAL PAGE CONTENT');
  put(memory, 'buckets/app/fact.md', 'x');
  symlinkSync(resolve(memory, 'buckets/app/notes.md'), resolve(memory, 'buckets/app/index.md'), 'file');
  const requests = [];
  assert.deepEqual(await run(async request => { requests.push(request); return selected(request.candidates); }), {});
  assert.doesNotMatch(JSON.stringify(requests), /TERMINAL PAGE CONTENT/);
  assert.match(JSON.parse(get(cwd, '.geppetto/hook-events.jsonl')).error, /index.*owner/i);
});

test('request preparation yields to cancellation before dispatch', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5);
  let calls = 0;
  const classify = candidateClassifier({ signal: controller.signal, maxRequestBytes: 100,
    requestBytes: () => { const stop = performance.now() + 25; while (performance.now() < stop) {} return 50; },
    request: async () => { calls++; return []; } });
  try { await assert.rejects(classify('buckets', [{ id: 'app' }]), /timed out|cancelled/); }
  finally { clearTimeout(timer); }
  assert.equal(calls, 0);
});
