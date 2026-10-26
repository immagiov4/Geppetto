import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRouterClassify, classificationPayload } from '../skills/geppetto-adopt/scripts/memory-provider.mjs';
import { defaultConfig } from '../skills/geppetto-adopt/scripts/common.mjs';
import { memoryClassifierSettings } from '../skills/geppetto-adopt/scripts/memory-config.mjs';

const request = () => ({ stage: 'buckets', model: 'selected/model', prompt: 'Question', candidates: [{ id: 'nous', description: 'Nous facts.' }], apiKey: 'fixture-key', signal: new AbortController().signal, maxOutputTokens: 128 });

test('the default memory classifier is Perplexity Decider Flash through typed decisions', async () => {
  const settings = memoryClassifierSettings({}, defaultConfig());
  assert.equal(settings.model, 'perplexity/pplx-decider-flash-v1.2');
  const input = { ...request(), model: settings.model }; let sent;
  const result = await openRouterClassify(input, { fetchImpl: async (url, options) => { sent = { url, body: JSON.parse(options.body) }; return { ok: true, json: async () => ({ answers: { nous: { noul: 0.9 } }, usage: { cost: 0.001 } }) }; } });
  assert.equal(sent.url, 'https://openrouter.ai/api/alpha/decisions');
  assert.deepEqual(sent.body, classificationPayload(input)); assert.deepEqual(sent.body.state, { message: 'Question' });
  assert.equal(sent.body.questions.nous.type, 'noul'); assert.ok(sent.body.questions.nous.instructions.includes('Nous facts.'));
  assert.equal(result.selections[0].score, 0.9); assert.equal(result.costUsd, 0.001);
});
test('OpenRouter adapter preserves the selected model, sends candidate descriptions and parses cost with schema-bound JSON', async () => {
  let sent;
  const fetchImpl = async (url, options) => { sent = { url, ...options }; return { ok: true, json: async () => ({ choices: [{ message: { content: '{"selections":[{"id":"nous","score":0.9,"reason":"Relevant"}]}' } }], usage: { cost: 0.001 } }) }; };
  const result = await openRouterClassify(request(), { fetchImpl });
  assert.deepEqual(result, { selections: [{ id: 'nous', score: 0.9, reason: 'Relevant' }], costUsd: 0.001 });
  assert.equal(sent.url, 'https://openrouter.ai/api/v1/chat/completions'); assert.equal(sent.headers.Authorization, 'Bearer fixture-key');
  const body = JSON.parse(sent.body); assert.equal(body.model, 'selected/model'); assert.equal(body.max_tokens, 128); assert.deepEqual(body.provider, { require_parameters: true, allow_fallbacks: false });
  assert.deepEqual(body.response_format.json_schema.schema.properties.selections.items.properties.id.enum, ['nous']);
  assert.deepEqual(JSON.parse(body.messages[1].content), { question: 'Question', candidates: [{ id: 'nous', description: 'Nous facts.' }] });
});

test('provider HTTP and malformed response errors surface safely and absent billing stays unknown', async () => {
  await assert.rejects(openRouterClassify(request(), { fetchImpl: async () => ({ ok: false, status: 429 }) }), /HTTP 429/);
  await assert.rejects(openRouterClassify(request(), { fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'bad' } }] }) }) }), /not valid JSON/);
  const result = await openRouterClassify(request(), { fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"selections":[]}' } }] }) }) }); assert.equal(result.costUsd, null);
});
