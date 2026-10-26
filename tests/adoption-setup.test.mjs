import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { fixture, put, get, git, config, scripts } from './helpers.mjs';
import { validateConfig } from '../skills/geppetto-adopt/scripts/common.mjs';

function childEnv(home, key) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  // Never inherit a developer's real credential into a fixture.
  for (const name of Object.keys(env)) if (name.toUpperCase() === 'OPENROUTER_API_KEY') delete env[name];
  if (key !== undefined) env.OPENROUTER_API_KEY = key;
  return env;
}
function probe(cwd, home, key, args = ['--check-credential']) {
  return spawnSync(process.execPath, [resolve(scripts, 'memory-hook.mjs'), ...args], { cwd, env: childEnv(home, key), input: '', encoding: 'utf8', windowsHide: true });
}

test('adoption can probe the hook environment without stdin, provider access, activation or secret output', t => {
  const cwd = fixture(t); const home = fixture(t);
  put(cwd, '.geppetto/config.json', { ...config(), hooks: { memoryClassifier: { enabled: false, benchmark: null } } });
  const before = get(cwd, '.geppetto/config.json');
  const result = probe(cwd, home, 'synthetic-present-key');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { credential: 'present', source: 'process-environment', providerAuthentication: 'not-verified' });
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-present-key/);
  assert.equal(get(cwd, '.geppetto/config.json'), before);
});

test('a missing or empty hook credential stays missing even when a .env file exists', t => {
  const cwd = fixture(t); const home = fixture(t);
  put(cwd, '.env', 'OPENROUTER_API_KEY=synthetic-file-only-key\n');
  for (const key of [undefined, '']) {
    const result = probe(cwd, home, key);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { credential: 'missing', source: null, providerAuthentication: 'not-verified' });
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-file-only-key/);
  }
});

test('credential probe rejects unsupported arguments rather than accepting a secret on the command line', t => {
  const cwd = fixture(t); const home = fixture(t);
  const result = probe(cwd, home, undefined, ['--check-credential', 'synthetic-argument-key']);
  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-argument-key/);
});

// This is a conversational test driver, not a product adoption engine. It emulates
// private entry, human consent and config edits. Hook, provider adapter, validation
// and spending-ledger code execute unchanged; only the HTTP transport is synthetic.
for (const source of ['existing', 'missing-then-private-entry']) {
  for (const decision of ['keep', 'decline', 'pending']) {
    test(`synthetic adoption: ${source}, comparison then ${decision} with persisted readback`, t => {
      const cwd = fixture(t); const home = fixture(t); const memory = fixture(t); const trial = fixture(t);
      assert.equal(git(memory, ['init', '-q']).status, 0);
      put(memory, 'index.md', '| Bucket | Scope | Holds |\n|---|---|---|\n| example | project | Synthetic playback facts. |\n');
      put(memory, 'buckets/example/index.md', '[Playback](playback.md) - Synthetic playback behavior.\n');
      put(memory, 'buckets/example/playback.md', 'Synthetic fact: playback starts muted.\n');
      const settings = { enabled: false, benchmark: null, model: 'fixture/model', bucketThreshold: 0.5, pageThreshold: 0.5, timeoutMs: 1000, maxOutputTokens: 64, maxCostUsd: 0.01 };
      put(cwd, '.geppetto/config.json', { ...config(), hooks: { memoryClassifier: settings }, memory: { repo: 'https://example.invalid/memory', localPath: memory, buckets: ['example'] } });
      const readConfig = dir => validateConfig(JSON.parse(get(dir, '.geppetto/config.json')), resolve(dir, '.geppetto/config.json'));
      const initial = get(cwd, '.geppetto/config.json');
      const steps = [{ actor: 'driver', step: 'setup accepted; automatic invocation disabled', enabled: readConfig(cwd).hooks.memoryClassifier.enabled }];
      let key = source === 'existing' ? 'synthetic-delivered-key' : undefined;
      const before = probe(cwd, home, key);
      assert.equal(before.status, key ? 0 : 1, before.stderr);
      steps.push({ actor: 'hook-probe', ...JSON.parse(before.stdout) });
      if (!key) {
        // No account, Wizard or secret store is accessed. This assignment emulates
        // the human completing private entry into an existing launcher mechanism.
        steps.push({ actor: 'simulated-human', step: 'private-entry delivery unavailable until human completes it', state: 'pending' });
        assert.equal(get(cwd, '.geppetto/config.json'), initial);
        key = 'synthetic-delivered-key';
        steps.push({ actor: 'simulated-human', step: 'private entry completed into synthetic child environment' });
      } else {
        steps.push({ actor: 'driver', step: 'reuse existing source; skip account and key creation' });
      }
      const available = probe(cwd, home, key);
      assert.equal(available.status, 0, available.stderr);
      steps.push({ actor: 'hook-probe', ...JSON.parse(available.stdout) });
      assert.equal(get(cwd, '.geppetto/config.json'), initial);

      const entry = resolve(cwd, 'hook-fixture.mjs');
      put(cwd, 'hook-fixture.mjs', `import assert from 'node:assert/strict';
import { handleMemoryEvent } from ${JSON.stringify(pathToFileURL(resolve(scripts, 'memory-hook.mjs')).href)};
import { openRouterClassify } from ${JSON.stringify(pathToFileURL(resolve(scripts, 'memory-provider.mjs')).href)};
const calls = [];
const provider = request => openRouterClassify(request, { fetchImpl: async (url, init) => {
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(init.headers.Authorization, 'Bearer synthetic-delivered-key');
  assert.doesNotMatch(init.body, /starts muted/);
  const body = JSON.parse(init.body);
  const { question, candidates } = JSON.parse(body.messages[1].content);
  calls.push({ requestBytes: Buffer.byteLength(init.body), candidates: candidates.map(c => c.id) });
  const selections = question.includes('playback') ? candidates.map(c => ({ id: c.id, score: 1, reason: 'Synthetic playback match' })) : [];
  return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ selections }) } }], usage: { cost: 0 } }) };
} });
const event = { cwd: process.cwd(), hook_event_name: process.argv[2], prompt: process.argv[3] };
const result = await handleMemoryEvent(event, { home: ${JSON.stringify(home)}, provider });
console.log(JSON.stringify({ result, calls }));
`);
      const runHook = (dir, event = 'UserPromptSubmit', prompt = 'How does playback start?') => {
        const result = spawnSync(process.execPath, [entry, event, prompt], { cwd: dir, env: childEnv(home, key), encoding: 'utf8', windowsHide: true });
        assert.equal(result.status, 0, result.stderr);
        assert.doesNotMatch(result.stdout + result.stderr, /synthetic-delivered-key/);
        return JSON.parse(result.stdout);
      };
      assert.deepEqual(runHook(cwd), { result: {}, calls: [] });
      const session = runHook(cwd, 'SessionStart');
      assert.equal(session.calls.length, 0);
      assert.match(session.result.hookSpecificOutput.additionalContext, /\[Playback\]\(playback.md\)/);
      // The driver emulates direct navigation from the injected index, then opens
      // the same leaf selected by the classifier. No page text reaches transport.
      const directFact = get(memory, 'buckets/example/playback.md');

      steps.push({ actor: 'simulated-human', step: 'separate consent to synthetic data scope and zero-cost comparison; no activation consent' });
      const grant = '[memory-classifier] provider=openrouter budget_usd=0.1 per=30d scope="synthetic fixture comparison" expires=2099-12-31\n';
      put(home, '.geppetto/authorizations', grant);
      put(trial, '.geppetto/authorizations', grant);
      const trialConfig = readConfig(cwd);
      trialConfig.hooks.memoryClassifier.enabled = true;
      put(trial, '.geppetto/config.json', trialConfig);
      const cases = [];
      for (const [prompt, expectedCalls] of [['How does playback start?', 2], ['Unrelated weather question', 1]]) {
        const baseline = runHook(cwd, 'UserPromptSubmit', prompt);
        assert.deepEqual(baseline, { result: {}, calls: [] });
        const observed = runHook(trial, 'UserPromptSubmit', prompt);
        assert.equal(observed.calls.length, expectedCalls);
        const context = observed.result.hookSpecificOutput?.additionalContext ?? '';
        if (expectedCalls === 2) assert.match(context, /buckets\/example\/playback.md/);
        else assert.equal(context, '');
        const openedFact = context ? get(memory, 'buckets/example/playback.md') : null;
        if (openedFact) assert.equal(openedFact, directFact);
        const log = JSON.parse(get(trial, '.geppetto/hook-events.jsonl').trim().split('\n').at(-1));
        assert.equal(log.status, 'ok'); assert.equal(log.modelCalls, expectedCalls); assert.equal(log.costUsd, 0);
        assert.equal(log.injectedBytes, Buffer.byteLength(context));
        cases.push({ prompt, baseline: { hook: baseline, indexInjectedBytes: Buffer.byteLength(session.result.hookSpecificOutput.additionalContext), navigation: 'driver emulates direct index navigation', openedFact: expectedCalls === 2 ? directFact : null }, assisted: { context, openedFact, calls: observed.calls, log } });
        assert.equal(get(cwd, '.geppetto/config.json'), initial);
        assert.deepEqual(runHook(cwd), { result: {}, calls: [] });
      }
      const ledger = get(home, '.geppetto/ledger.jsonl').trim().split('\n').map(JSON.parse);
      assert.deepEqual(ledger.map(e => e.type), ['reserve', 'settle', 'reserve', 'settle']);
      assert.ok(ledger.filter(e => e.type === 'settle').every(e => e.actual === 0));
      const benchmarkRef = '.geppetto/synthetic-memory-comparison.json';
      put(cwd, benchmarkRef, { synthetic: true, transport: 'injected fixture, no network', model: settings.model, limits: settings, cases });
      const benchmark = JSON.parse(get(cwd, benchmarkRef));
      steps.push({ actor: 'driver', step: 'show observed synthetic results before asking keep/decline/pending', benchmark: benchmarkRef, cases: benchmark.cases });
      const awaitingDecision = readConfig(cwd);
      awaitingDecision.hooks.memoryClassifier.benchmark = benchmarkRef;
      put(cwd, '.geppetto/config.json', awaitingDecision);
      assert.equal(readConfig(cwd).hooks.memoryClassifier.enabled, false);
      assert.deepEqual(runHook(cwd), { result: {}, calls: [] });

      // Explicit scripted answers emulate conversation. No production code chooses
      // a decision or changes config on the strength of benchmark results.
      steps.push({ actor: 'simulated-human', step: decision === 'pending' ? 'no answer' : `explicit ${decision}` });
      const chosen = readConfig(cwd);
      if (decision === 'keep') {
        chosen.hooks.memoryClassifier.enabled = true;
        chosen.pillars.memoryClassifier = 'installed';
        put(cwd, '.geppetto/authorizations', grant);
      } else if (decision === 'decline') chosen.pillars.memoryClassifier = 'declined';
      put(cwd, '.geppetto/config.json', chosen);
      const final = readConfig(cwd);
      assert.equal(final.hooks.memoryClassifier.enabled, decision === 'keep');
      assert.equal(final.hooks.memoryClassifier.benchmark, benchmarkRef);
      assert.equal(final.pillars.memoryClassifier, decision === 'pending' ? undefined : decision === 'keep' ? 'installed' : 'declined');
      assert.equal(runHook(cwd).calls.length, decision === 'keep' ? 2 : 0);
      assert.equal(probe(cwd, home, key).status, 0);
      if (decision === 'decline') {
        // Rerun discovery is conversational too: read and retain the refusal,
        // offer nothing and make no config write or provider request.
        const refused = get(cwd, '.geppetto/config.json');
        const rerun = readConfig(cwd);
        assert.equal(rerun.pillars.memoryClassifier, 'declined');
        assert.equal(rerun.hooks.memoryClassifier.enabled, false);
        assert.deepEqual(runHook(cwd), { result: {}, calls: [] });
        assert.equal(get(cwd, '.geppetto/config.json'), refused);
        steps.push({ actor: 'driver', step: 'rerun reads refusal; no offer, edit or benchmark' });
      }
      put(cwd, '.geppetto/synthetic-adoption-report.json', { synthetic: true, source, state: decision === 'keep' ? 'kept' : decision === 'decline' ? 'declined' : 'pending', benchmark: benchmarkRef, enabled: final.hooks.memoryClassifier.enabled, steps });
      const report = JSON.parse(get(cwd, '.geppetto/synthetic-adoption-report.json'));
      assert.equal(report.enabled, readConfig(cwd).hooks.memoryClassifier.enabled);
      assert.equal(report.benchmark, readConfig(cwd).hooks.memoryClassifier.benchmark);
      assert.doesNotMatch(JSON.stringify({ final, report, benchmark }) + get(cwd, '.geppetto/hook-events.jsonl') + get(trial, '.geppetto/hook-events.jsonl'), /synthetic-delivered-key/);
      t.diagnostic(JSON.stringify({ ...report, finalConfig: final, benchmarkArtifact: benchmark }));
    });
  }
}
