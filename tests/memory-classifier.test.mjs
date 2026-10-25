import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, put, get, git, config } from './helpers.mjs';
import { handleMemoryEvent } from '../skills/geppetto-adopt/scripts/memory-hook.mjs';

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

test('two stages select global plus linked project buckets, then only indexed pages, without reading private/page content', async t => {
  const { cwd, home, event } = setup(t); const calls = []; const spending = [];
  const provider = async request => {
    calls.push(request);
    return request.stage === 'buckets' ? { selections: [{ id: 'preferences', score: 0.75, reason: 'Windows preferences' }, { id: 'my-app', score: 0.9, reason: 'Playback' }], costUsd: 0.001 } : { selections: [{ id: 'buckets/my-app/playback.md', score: 0.8, reason: 'Explains\nplayback.' }, { id: 'buckets/preferences/windows.md', score: 0.79, reason: 'Below threshold.' }], costUsd: 0.002 };
  };
  const result = await handleMemoryEvent(event, { home, provider, authorization: auth(spending), env: { OPENROUTER_API_KEY: 'fixture-key' } });
  assert.equal(result.hookSpecificOutput.additionalContext, 'You may want to check out:\n- buckets/my-app/playback.md — Explains playback.');
  assert.equal(calls.length, 2); assert.deepEqual(calls[0].candidates.map(c => c.id), ['preferences', 'my-app']);
  assert.deepEqual(calls[1].candidates.map(c => c.id), ['buckets/preferences/windows.md', 'buckets/my-app/playback.md']);
  assert.equal(calls[0].model, 'owner/model'); assert.equal(calls[0].prompt, event.prompt); assert.equal(calls[1].maxOutputTokens, 256);
  assert.doesNotMatch(JSON.stringify(calls), /PRIVATE INDEX|PAGE SECRET|UNLINKED INDEX|secret\.md/);
  assert.equal(spending[0][0], 'reserve'); assert.equal(spending[0][2], 0.01); assert.equal(spending[1][0], 'settle'); assert.equal(spending[1][2], 0.003);
  const log = JSON.parse(get(cwd, '.geppetto/hook-events.jsonl')); assert.equal(log.modelCalls, 2); assert.equal(log.costUsd, 0.003); assert.equal(log.injectedBytes, Buffer.byteLength(result.hookSpecificOutput.additionalContext));
});

test('disabled and missing-key classifiers make no provider call; config credentials are never used', async t => {
  const disabled = setup(t, { enabled: false }); const missing = setup(t, { apiKey: 'config-is-not-a-key-source' }); let calls = 0;
  const provider = async () => { calls++; return { selections: [], costUsd: 0 }; };
  assert.deepEqual(await handleMemoryEvent(disabled.event, { home: disabled.home, provider, env: { OPENROUTER_API_KEY: 'fixture' } }), {});
  assert.deepEqual(await handleMemoryEvent(missing.event, { home: missing.home, provider, env: {} }), {});
  assert.equal(calls, 0); assert.match(get(missing.cwd, '.geppetto/hook-events.jsonl'), /key.*environment|credentials.*config/i);
});

test('timeout, provider failure and out-of-candidate selections inject nothing and leave a measurable error', async t => {
  for (const [mode, provider] of [['timeout', async () => new Promise(() => {})], ['failure', async () => { throw new Error('provider token=secret-value failed'); }], ['unknown-id', async () => ({ selections: [{ id: 'private', score: 1, reason: 'Outside candidates' }], costUsd: 0 })]]) {
    const { cwd, home, event } = setup(t, { timeoutMs: 10 });
    const result = await handleMemoryEvent(event, { home, provider, authorization: auth([]), env: { OPENROUTER_API_KEY: 'fixture' } });
    assert.deepEqual(result, {}, mode); const log = JSON.parse(get(cwd, '.geppetto/hook-events.jsonl')); assert.equal(log.status, 'error'); assert.equal(log.injectedBytes, 0); assert.ok(log.error); assert.doesNotMatch(JSON.stringify(log), /secret-value/);
    if (mode === 'timeout') { assert.match(log.error, /timed out/); assert.equal(log.costUsd, null); }
  }
});

test('known charges settle even for rejected provider selections; unknown charges keep their reservation', async t => {
  const known = setup(t); const spending = [];
  await handleMemoryEvent(known.event, { home: known.home, authorization: auth(spending), env: { OPENROUTER_API_KEY: 'fixture' }, provider: async () => ({ selections: [{ id: 'private', score: 1, reason: 'Rejected' }], costUsd: 0.002 }) });
  assert.equal(spending[1][0], 'settle'); assert.equal(spending[1][2], 0.002);
  const unknown = setup(t); const pending = [];
  assert.deepEqual(await handleMemoryEvent(unknown.event, { home: unknown.home, authorization: auth(pending), env: { OPENROUTER_API_KEY: 'fixture' }, provider: async () => ({ selections: [], costUsd: null }) }), {});
  assert.equal(pending.length, 1); assert.equal(JSON.parse(get(unknown.cwd, '.geppetto/hook-events.jsonl')).costUsd, null);
});

test('the automatic hook uses the real user/project ledger and never obtains a task grant from configuration', async t => {
  const { cwd, home, event } = setup(t);
  const grant = '[memory-classifier] provider=openrouter budget_usd=0.1 per=30d scope="memory selection in fixture" expires=2099-12-31\n';
  put(home, '.geppetto/authorizations', grant); put(cwd, '.geppetto/authorizations', grant);
  const result = await handleMemoryEvent(event, { home, env: { OPENROUTER_API_KEY: 'fixture' }, provider: async () => ({ selections: [], costUsd: 0.001 }) });
  assert.deepEqual(result, {}); const events = get(home, '.geppetto/ledger.jsonl').trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 2); assert.equal(events[0].capability, 'memory-classifier'); assert.equal(events[0].reserved, 10000); assert.equal(events[1].actual, 1000); assert.equal(events[0].taskGrant, undefined);
});

test('bucket scores below the configured threshold skip stage two and invalid configuration stays local', async t => {
  const { cwd, home, event } = setup(t); let calls = 0;
  const result = await handleMemoryEvent(event, { home, env: { OPENROUTER_API_KEY: 'fixture' }, authorization: auth([]), provider: async () => { calls++; return { selections: [{ id: 'my-app', score: 0.74, reason: 'Too weak' }], costUsd: 0 }; } });
  assert.deepEqual(result, {}); assert.equal(calls, 1); assert.equal(JSON.parse(get(cwd, '.geppetto/hook-events.jsonl')).modelCalls, 1);
  const invalid = setup(t, { pageThreshold: 2 }); calls = 0;
  assert.deepEqual(await handleMemoryEvent(invalid.event, { home: invalid.home, env: { OPENROUTER_API_KEY: 'fixture' }, provider: async () => { calls++; } }), {});
  assert.equal(calls, 0); assert.match(get(invalid.cwd, '.geppetto/hook-events.jsonl'), /pageThreshold/);
});

test('no selected buckets stops after stage one and an authorization denial starts no provider request', async t => {
  const { cwd, home, event } = setup(t); let calls = 0; const spending = [];
  const provider = async () => { calls++; return { selections: [], costUsd: 0.001 }; };
  assert.deepEqual(await handleMemoryEvent(event, { home, provider, authorization: auth(spending), env: { OPENROUTER_API_KEY: 'fixture' } }), {});
  assert.equal(calls, 1); assert.equal(spending[1][2], 0.001); assert.equal(JSON.parse(get(cwd, '.geppetto/hook-events.jsonl')).status, 'ok');
  const denied = setup(t); calls = 0;
  assert.deepEqual(await handleMemoryEvent(denied.event, { home: denied.home, provider, authorization: { reserve: async () => { throw new Error('deny Project does not grant this capability'); } }, env: { OPENROUTER_API_KEY: 'fixture' } }), {}); assert.equal(calls, 0);
  assert.match(get(denied.cwd, '.geppetto/hook-events.jsonl'), /does not grant/);
});
