import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, put, get, git, config, invoke } from './helpers.mjs';
import { classifyMemory } from '../skills/geppetto-adopt/scripts/memory-classifier.mjs';
const runClassifier = (event, options) => classifyMemory(event, { project: event.cwd, ...options });
import { openRouterClassify } from '../skills/geppetto-adopt/scripts/memory-provider.mjs';

const classifier = { enabled: true, benchmark: null, model: 'owner/model', bucketThreshold: 0.75, pageThreshold: 0.8, timeoutMs: 1000, maxOutputTokens: 256, maxCostUsd: 0.01 };
function setup(t, overrides = {}) {
  const cwd = fixture(t); const home = fixture(t); const memory = fixture(t); git(memory, ['init', '-q']);
  put(memory, 'index.md', '| Bucket | Scope | Holds |\n|---|---|---|\n| private | global | Personal facts. |\n| preferences | global | Working preferences. |\n| my-app | project | My app facts. |\n| other | project | Another project. |\n');
  put(memory, 'buckets/preferences/index.md', '# Preferences\n[Windows](windows.md) — Hidden process flags.\n');
  put(memory, 'buckets/my-app/index.md', '# My app\n[Playback](playback.md) — Playback behavior.\n[Escape](../../private/secret.md) — Outside bucket.\n');
  put(memory, 'buckets/private/index.md', 'PRIVATE INDEX'); put(memory, 'buckets/other/index.md', 'UNLINKED INDEX');
  put(memory, 'buckets/my-app/playback.md', 'PAGE SECRET'); put(memory, 'buckets/preferences/windows.md', 'ANOTHER PAGE SECRET');
  put(cwd, '.geppetto/config.json', { ...config(), memory: { repo: 'https://example.invalid/memory', localPath: memory, buckets: ['my-app'] }, hooks: { memoryClassifier: { ...classifier, ...overrides } } });
  return { cwd, home, memory, event: { cwd, hook_event_name: 'UserPromptSubmit', prompt: 'How does playback behave on Windows?' } };
}
const auth = calls => ({ reserve: async (...args) => calls.push(['reserve', ...args]), settle: async (...args) => calls.push(['settle', ...args]) });

test('a minimal existing memory-classifier config inherits Flash and the baseline retrieval settings', async t => {
  const { cwd, home, event } = setup(t);
  const config = JSON.parse(get(cwd, '.geppetto/config.json')); config.hooks.memoryClassifier = { enabled: true, benchmark: null };
  put(cwd, '.geppetto/config.json', config); const requests = [];
  const result = await runClassifier(event, { home, authorization: auth([]), env: { OPENROUTER_API_KEY: 'fixture' }, provider: async request => {
    requests.push(request);
    const selected = request.stage === 'buckets' ? 'my-app' : 'buckets/my-app/playback.md';
    return { selections: request.candidates.filter(candidate => candidate.id === selected).map(candidate => ({ id: candidate.id, score: 0.7, reason: 'Relevant' })), costUsd: 0 };
  } });
  assert.match(result.hookSpecificOutput.additionalContext, /playback.md/);
  assert.equal(requests.length, 2); assert.ok(requests.every(request => request.model === 'perplexity/pplx-decider-flash-v1.2'));
  const audit = invoke('audit.mjs', ['--json'], { cwd, home, env: { OPENROUTER_API_KEY: 'fixture', PATH: '' } });
  assert.equal(audit.status, 0, audit.stderr); const readiness = JSON.parse(audit.stdout).memoryClassifier;
  assert.deepEqual(readiness, { enabled: false, action: null });
});

test('a malformed billed memory response preserves its charge through the shared coordinator', async t => {
  const { home, event } = setup(t); const spending = [];
  const provider = request => openRouterClassify(request, { fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'malformed' } }], usage: { cost: 0.002 } }) }) });
  const result = await runClassifier(event, { home, provider, authorization: auth(spending), env: { OPENROUTER_API_KEY: 'fixture' } });
  assert.deepEqual(result, {}); assert.equal(spending.at(-1)[0], 'settle'); assert.equal(spending.at(-1)[2], 0.002);
});

test('bucket selection explores global and linked project indexes without reading private/page content', async t => {
  const { cwd, home, event } = setup(t); const calls = []; const spending = [];
  const provider = async request => {
    calls.push(request);
    const selections = request.stage === 'buckets' ? [{ id: 'preferences', score: 0.75, reason: 'Windows preferences' }, { id: 'my-app', score: 0.9, reason: 'Playback' }] : [{ id: 'buckets/my-app/playback.md', score: 0.8, reason: 'Explains\nplayback.' }, { id: 'buckets/preferences/windows.md', score: 0.79, reason: 'Below threshold.' }];
    return { selections: selections.filter(entry => request.candidates.some(candidate => candidate.id === entry.id)), costUsd: request.stage === 'buckets' ? 0.001 : 0.002 };
  };
  const result = await runClassifier(event, { home, provider, authorization: auth(spending), env: { OPENROUTER_API_KEY: 'fixture-key' } });
  assert.equal(result.hookSpecificOutput.additionalContext, 'You may want to check out:\n- buckets/my-app/playback.md — Explains playback.');
  assert.equal(calls.length, 3); assert.deepEqual(calls[0].candidates.map(c => c.id), ['preferences', 'my-app']);
  assert.deepEqual(calls.slice(1).flatMap(call => call.candidates.map(c => c.id)).sort(), ['buckets/my-app/playback.md', 'buckets/preferences/windows.md']);
  assert.equal(calls[0].model, 'owner/model'); assert.equal(calls[0].prompt, event.prompt); assert.equal(calls[1].maxOutputTokens, 256);
  assert.doesNotMatch(JSON.stringify(calls), /PRIVATE INDEX|PAGE SECRET|UNLINKED INDEX|secret\.md/);
  assert.equal(spending[0][0], 'reserve'); assert.equal(spending[0][2], 0.01); assert.equal(spending[1][0], 'settle'); assert.equal(spending[1][2], 0.005);
  const log = JSON.parse(get(cwd, '.geppetto/hook-events.jsonl')); assert.equal(log.modelCalls, 3); assert.equal(log.costUsd, 0.005); assert.equal(log.injectedBytes, Buffer.byteLength(result.hookSpecificOutput.additionalContext));
});

test('disabled and missing-key classifiers make no provider call; config credentials are never used', async t => {
  const disabled = setup(t, { enabled: false }); const missing = setup(t, { apiKey: 'config-is-not-a-key-source' }); let calls = 0;
  const provider = async () => { calls++; return { selections: [], costUsd: 0 }; };
  assert.deepEqual(await runClassifier(disabled.event, { home: disabled.home, provider, env: { OPENROUTER_API_KEY: 'fixture' } }), {});
  assert.deepEqual(await runClassifier(missing.event, { home: missing.home, provider, env: {} }), {});
  assert.equal(calls, 0); assert.match(get(missing.cwd, '.geppetto/hook-events.jsonl'), /key.*environment|credentials.*config/i);
});

test('timeout, provider failure and out-of-candidate selections inject nothing and leave a measurable error', async t => {
  for (const [mode, provider] of [['timeout', async () => new Promise(() => {})], ['failure', async () => { throw new Error('provider token=secret-value failed'); }], ['unknown-id', async () => ({ selections: [{ id: 'private', score: 1, reason: 'Outside candidates' }], costUsd: 0 })]]) {
    const { cwd, home, event } = setup(t, { timeoutMs: 10 });
    const result = await runClassifier(event, { home, provider, authorization: auth([]), env: { OPENROUTER_API_KEY: 'fixture' } });
    assert.deepEqual(result, {}, mode); const log = JSON.parse(get(cwd, '.geppetto/hook-events.jsonl')); assert.equal(log.status, 'error'); assert.equal(log.injectedBytes, 0); assert.ok(log.error); assert.doesNotMatch(JSON.stringify(log), /secret-value/);
    if (mode === 'timeout') { assert.match(log.error, /timed out/); assert.equal(log.costUsd, null); }
  }
});

test('known charges settle even for rejected provider selections; unknown charges keep their reservation', async t => {
  const known = setup(t); const spending = [];
  await runClassifier(known.event, { home: known.home, authorization: auth(spending), env: { OPENROUTER_API_KEY: 'fixture' }, provider: async () => ({ selections: [{ id: 'private', score: 1, reason: 'Rejected' }], costUsd: 0.002 }) });
  assert.equal(spending[1][0], 'settle'); assert.equal(spending[1][2], 0.002);
  const unknown = setup(t); const pending = [];
  assert.deepEqual(await runClassifier(unknown.event, { home: unknown.home, authorization: auth(pending), env: { OPENROUTER_API_KEY: 'fixture' }, provider: async () => ({ selections: [], costUsd: null }) }), {});
  assert.equal(pending.length, 1); assert.equal(JSON.parse(get(unknown.cwd, '.geppetto/hook-events.jsonl')).costUsd, null);
});

test('explicit classifier experiments account paid API usage using the machine key', async t => {
  const { cwd, home, event } = setup(t);
  const result = await runClassifier(event, { home, env: { OPENROUTER_API_KEY: 'fixture' }, provider: async () => ({ selections: [], costUsd: 0.001 }) });
  assert.deepEqual(result, {}); const events = get(home, '.geppetto/api-usage.jsonl').trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 2); assert.equal(events[0].capability, 'memory-classifier'); assert.equal(events[0].reserved, 10000); assert.equal(events[1].actual, 1000);
});

test('bucket scores below the configured threshold skip stage two and invalid configuration stays local', async t => {
  const { cwd, home, event } = setup(t); let calls = 0;
  const result = await runClassifier(event, { home, env: { OPENROUTER_API_KEY: 'fixture' }, authorization: auth([]), provider: async () => { calls++; return { selections: [{ id: 'my-app', score: 0.74, reason: 'Too weak' }], costUsd: 0 }; } });
  assert.deepEqual(result, {}); assert.equal(calls, 1); assert.equal(JSON.parse(get(cwd, '.geppetto/hook-events.jsonl')).modelCalls, 1);
  const invalid = setup(t, { pageThreshold: 2 }); calls = 0;
  assert.deepEqual(await runClassifier(invalid.event, { home: invalid.home, env: { OPENROUTER_API_KEY: 'fixture' }, provider: async () => { calls++; } }), {});
  assert.equal(calls, 0); assert.match(get(invalid.cwd, '.geppetto/hook-events.jsonl'), /pageThreshold/);
});

test('no selected buckets stops after stage one and an authorization denial starts no provider request', async t => {
  const { cwd, home, event } = setup(t); let calls = 0; const spending = [];
  const provider = async () => { calls++; return { selections: [], costUsd: 0.001 }; };
  assert.deepEqual(await runClassifier(event, { home, provider, authorization: auth(spending), env: { OPENROUTER_API_KEY: 'fixture' } }), {});
  assert.equal(calls, 1); assert.equal(spending[1][2], 0.001); assert.equal(JSON.parse(get(cwd, '.geppetto/hook-events.jsonl')).status, 'ok');
  const denied = setup(t); calls = 0;
  assert.deepEqual(await runClassifier(denied.event, { home: denied.home, provider, authorization: { reserve: async () => { throw new Error('deny Project does not grant this capability'); } }, env: { OPENROUTER_API_KEY: 'fixture' } }), {}); assert.equal(calls, 0);
  assert.match(get(denied.cwd, '.geppetto/hook-events.jsonl'), /does not grant/);
});

test('an explicitly enabled experiment needs no cost cap or benchmark', async t => {
  const { cwd, home, event } = setup(t, { enabled: true, maxCostUsd: undefined });
  let calls = 0;
  await runClassifier(event, { home, env: { OPENROUTER_API_KEY: 'fixture-only' }, provider: async () => { calls++; return { selections: [], costUsd: 0.02 }; } });
  assert.equal(calls, 1);
  const ledger = get(home, '.geppetto/api-usage.jsonl').trim().split('\n').map(JSON.parse);
  assert.equal(ledger[0].reserved, null); assert.equal(ledger[1].actual, 20000);
  assert.equal(JSON.parse(get(cwd, '.geppetto/config.json')).hooks.memoryClassifier.benchmark, null);
});
