import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, put, get, invoke, repo } from './helpers.mjs';
import { handleSkillEvent } from '../skills/geppetto-adopt/scripts/skill-hook.mjs';
import { skillSelectionPayload, openRouterSelectSkills } from '../skills/geppetto-adopt/scripts/skill-provider.mjs';
import { skillCatalog } from '../skills/geppetto-adopt/scripts/skill-catalog.mjs';

const settings = { enabled: true, benchmark: null, model: 'owner/decider', threshold: 0.75, timeoutMs: 1000, batchSize: 80, maxCostUsd: 0.01 };
function setup(t, overrides = {}) {
  const cwd = fixture(t), home = fixture(t);
  put(cwd, '.geppetto/config.json', { hooks: { skillSelector: { ...settings, ...overrides } } });
  for (const [root, body] of [[home, 'Global implementation'], [cwd, 'PROJECT BODY MUST STAY LOCAL']]) {
    put(root, '.agents/skills/review/SKILL.md', `---\nname: review\ndescription: Review changes before publishing.\n---\n${body}`);
  }
  put(home, '.agents/skills/draw/SKILL.md', '---\nname: draw\ndescription: Draw pictures.\n---\nBODY');
  put(cwd, '.agents/skills/review/agents/openai.yaml', 'policy:\n  allow_implicit_invocation: false\n');
  return { cwd, home, event: { cwd, hook_event_name: 'UserPromptSubmit', session_id: 'same-session', prompt: 'Review these changes' } };
}
const authority = calls => ({ reserve: async (...args) => calls.push(['reserve', ...args]), settle: async (...args) => calls.push(['settle', ...args]) });

test('each prompt suggests matching skills with project precedence and without loading procedure bodies', async t => {
  const { cwd, home, event } = setup(t); const calls = [], spending = [];
  const provider = async request => {
    calls.push(request);
    assert.equal(spending.at(-1)[0], 'reserve');
    assert.ok(!JSON.stringify(request.candidates).includes('BODY'));
    return { selections: request.candidates.filter(c => c.name === 'review').map(c => ({ id: c.id, score: 0.9, reason: 'Matches review work' })), costUsd: 0.001 };
  };
  for (let turn = 0; turn < 2; turn++) {
    const result = await handleSkillEvent(event, { home, provider, authorization: authority(spending), env: { OPENROUTER_API_KEY: 'fixture' } });
    const context = result.hookSpecificOutput.additionalContext;
    assert.match(context, /review/); assert.ok(context.includes(`${cwd.replaceAll('\\', '/')}/.agents/skills/review/SKILL.md`));
    assert.ok(!context.includes(`${home.replaceAll('\\', '/')}/.agents/skills/review`));
  }
  assert.equal(calls.length, 2); assert.deepEqual(spending.map(c => c[0]), ['reserve', 'settle', 'reserve', 'settle']);
  const log = get(cwd, '.geppetto/hook-events.jsonl'); assert.match(log, /skillSelector/); assert.ok(!log.includes(event.prompt));
});

test('skill selection is independent of memory setup and declines, absent keys or denied consent make no provider call', async t => {
  for (const mode of ['declined', 'missing-key', 'denied', 'blank', 'other-event', 'child']) {
    const { cwd, home, event } = setup(t, mode === 'declined' ? { enabled: false } : {}); let calls = 0;
    const previous = process.env.GEPPETTO_LEARNING_CHILD;
    if (mode === 'child') process.env.GEPPETTO_LEARNING_CHILD = '1';
    try {
      const result = await handleSkillEvent({ ...event, ...(mode === 'blank' ? { prompt: ' ' } : {}), ...(mode === 'other-event' ? { hook_event_name: 'Stop' } : {}) }, { home, env: mode === 'missing-key' ? {} : { OPENROUTER_API_KEY: 'fixture' }, authorization: { reserve: async () => { throw new Error('Consent denied'); } }, provider: async () => { calls++; } });
      assert.deepEqual(result, {}); assert.equal(calls, 0);
    } finally { if (previous === undefined) delete process.env.GEPPETTO_LEARNING_CHILD; else process.env.GEPPETTO_LEARNING_CHILD = previous; }
  }
});

test('decision adapter reuses per-skill NOUL questions and validates exact returned IDs', async () => {
  const request = { model: 'owner/decider', prompt: 'Review changes', candidates: [{ id: 'review', name: 'review', description: 'Review code' }], apiKey: 'fixture', signal: new AbortController().signal };
  const payload = skillSelectionPayload(request);
  assert.equal(payload.questions.review.type, 'noul'); assert.match(payload.questions.review.instructions, /Review code/);
  assert.deepEqual(payload.state, { message: 'Review changes' });
  let observed;
  const result = await openRouterSelectSkills(request, { fetchImpl: async (url, options) => { observed = { url, options }; return { ok: true, json: async () => ({ answers: { review: { noul: 0.9 } }, usage: { cost: 0.0003 } }) }; } });
  assert.equal(observed.url, 'https://openrouter.ai/api/alpha/decisions'); assert.deepEqual(JSON.parse(observed.options.body), payload);
  assert.equal(result.selections[0].score, 0.9); assert.equal(result.costUsd, 0.0003);
  await assert.rejects(openRouterSelectSkills(request, { fetchImpl: async () => ({ ok: true, json: async () => ({ answers: { unknown: { noul: 0.9 } }, usage: { cost: 0.002 } }) }) }), error => error.costUsd === 0.002 && /candidate|selection|answer/i.test(error.message));
});

test('invalid decision answers retain known charges for settlement', async t => {
  const { home, event } = setup(t); const spending = [];
  const result = await handleSkillEvent(event, { home, env: { OPENROUTER_API_KEY: 'fixture' }, authorization: authority(spending), provider: request => openRouterSelectSkills(request, { fetchImpl: async () => ({ ok: true, json: async () => ({ answers: {}, usage: { cost: 0.002 } }) }) }) });
  assert.deepEqual(result, {}); assert.equal(spending.at(-1)[0], 'settle'); assert.equal(spending.at(-1)[2], 0.002);
});

test('YAML scalar source remains readable without imposing JSON syntax on all skill descriptions', async t => {
  const { cwd, home } = setup(t);
  put(cwd, '.agents/skills/yaml/SKILL.md', '---\nname: yaml\ndescription: "Review\\x20code"\n---\nBody');
  const catalog = await skillCatalog(cwd, home, {}, { CODEX_HOME: home });
  assert.ok(catalog.some(skill => skill.name === 'review'));
  assert.equal(catalog.find(skill => skill.name === 'yaml').description, 'Review\\x20code');
});

test('null concurrency is rejected by readiness before any reservation or provider request', async t => {
  const { cwd, home, event } = setup(t, { maxConcurrentRequests: null }); const spending = []; let calls = 0;
  const result = await handleSkillEvent(event, { home, env: { OPENROUTER_API_KEY: 'fixture' }, authorization: authority(spending), provider: async () => { calls++; } });
  assert.deepEqual(result, {}); assert.deepEqual(spending, []); assert.equal(calls, 0);
  const audit = invoke('audit.mjs', ['--json'], { cwd, home, env: { OPENROUTER_API_KEY: 'fixture', PATH: '' } });
  assert.equal(audit.status, 0, audit.stderr); const selector = JSON.parse(audit.stdout).skillSelector;
  assert.equal(selector.enabled, false); assert.match(selector.action, /settings|model.*threshold/);
});

test('plugin ships and executes the skill selector declaration independently of a personal Mercury hook', t => {
  const cwd = fixture(t); const hooks = JSON.parse(get(repo, 'hooks/hooks.json')).hooks.UserPromptSubmit.flatMap(group => group.hooks);
  const declaration = hooks.find(h => h.command.includes('/skill-hook.mjs')); assert.ok(declaration, 'Geppetto registers its own skill selector');
  const command = declaration.command.replace('${CLAUDE_PLUGIN_ROOT}', repo);
  const script = command.match(/^node "([^"]+)"$/)?.[1]; assert.ok(script);
  const result = invoke(script, [], { cwd, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd, prompt: ' ' }) });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), {});
});

test('batched skill decisions share the deadline, aggregate known charges and keep unknown charges reserved', async t => {
  const { cwd, home, event } = setup(t, { batchSize: 1 }); const spending = []; let calls = 0;
  const result = await handleSkillEvent(event, { home, env: { OPENROUTER_API_KEY: 'fixture' }, authorization: authority(spending), provider: async request => { calls++; assert.equal(request.candidates.length, 1); return { selections: [], costUsd: 0.001 }; } });
  assert.deepEqual(result, {}); assert.ok(calls > 1); assert.equal(spending.at(-1)[0], 'settle'); assert.equal(spending.at(-1)[2].toFixed(6), (calls * 0.001).toFixed(6));
  put(cwd, '.geppetto/config.json', { hooks: { skillSelector: { ...settings, timeoutMs: 10 } } });
  const unsettled = []; let aborted = false;
  const timeout = await handleSkillEvent(event, { home, env: { OPENROUTER_API_KEY: 'fixture' }, authorization: authority(unsettled), provider: request => new Promise((resolve, reject) => request.signal.addEventListener('abort', () => { aborted = true; reject(new Error('Aborted')); }, { once: true })) });
  assert.deepEqual(timeout, {}); assert.equal(aborted, true); assert.deepEqual(unsettled.map(c => c[0]), ['reserve']);
});

test('audit exposes the skill selector as its own pending capability', t => {
  const { cwd, home } = setup(t);
  const result = invoke('audit.mjs', ['--json'], { cwd, home, env: { OPENROUTER_API_KEY: 'fixture', PATH: '' } });
  assert.equal(result.status, 0, result.stderr);
  const selector = JSON.parse(result.stdout).skillSelector;
  assert.equal(selector.enabled, false); assert.match(selector.action, /standing.*skill-selector/);
});
