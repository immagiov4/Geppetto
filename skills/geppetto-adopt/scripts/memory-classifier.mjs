import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { jsonFile, userHome, run } from './common.mjs';
import { memorySettings } from './memory-config.mjs';
import { memoryCatalog, memoryIndex } from './memory-index.mjs';
import { logHookEvent } from './hook-events.mjs';
import { openRouterClassify } from './memory-provider.mjs';
import { redact } from './signal.mjs';

function validateSettings(settings) {
  if (typeof settings.model !== 'string' || !settings.model.trim()) throw new Error('memoryClassifier needs an owner-selected model');
  for (const field of ['bucketThreshold', 'pageThreshold']) if (!Number.isFinite(settings[field]) || settings[field] < 0 || settings[field] > 1) throw new Error(`memoryClassifier.${field} must be between 0 and 1`);
  for (const field of ['timeoutMs', 'maxOutputTokens']) if (!Number.isSafeInteger(settings[field]) || settings[field] <= 0) throw new Error(`memoryClassifier.${field} must be a positive integer`);
  if (!Number.isFinite(settings.maxCostUsd) || settings.maxCostUsd < 0 || !/^\d+(?:\.\d{1,6})?$/.test(String(settings.maxCostUsd))) throw new Error('memoryClassifier.maxCostUsd must bound this run in USD (at most six decimals)');
  if (['key', 'apiKey', 'api_key', 'secret'].some(field => field in settings)) throw new Error('Memory classifier credentials belong in the environment or secret store, outside config');
}

function selections(result, candidates, threshold) {
  if (!Array.isArray(result.selections)) throw new Error('Classifier selections must be an array');
  const allowed = new Set(candidates.map(candidate => candidate.id)); const seen = new Set();
  for (const entry of result.selections) {
    if (!entry || !allowed.has(entry.id) || seen.has(entry.id) || !Number.isFinite(entry.score) || entry.score < 0 || entry.score > 1 || typeof entry.reason !== 'string' || !entry.reason.trim()) throw new Error('Classifier returned an invalid or out-of-candidate selection');
    seen.add(entry.id);
  }
  return result.selections.filter(entry => entry.score >= threshold);
}

function indexedPages(text, bucket) {
  const pages = new Map();
  for (const line of text.split(/\r?\n/)) for (const link of line.matchAll(/\[([^\]]+)\]\(([^\s)]+)\)/g)) {
    let target;
    try { target = decodeURIComponent(link[2].split('#')[0]); } catch { continue; }
    target = target.replace(/^\.\//, '');
    const prefix = `buckets/${bucket}/`;
    if (target.startsWith(prefix)) target = target.slice(prefix.length);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.md$/.test(target) || target.split('/').some(segment => segment === '..' || segment === '.') || target === 'index.md' || target.startsWith('buckets/')) continue;
    const id = `${prefix}${target}`;
    pages.set(id, { id, description: line.replace(link[0], link[1]).trim() });
  }
  return [...pages.values()];
}

function ledgerAuthorization(project, home) {
  const command = args => {
    const result = run(process.execPath, [fileURLToPath(new URL('./authz.mjs', import.meta.url)), ...args], { cwd: project, env: { ...process.env, HOME: home, USERPROFILE: home } });
    if (result.status !== 0) throw new Error(`Memory classifier authorization: ${redact(result.stdout?.trim() || result.stderr?.trim() || result.error?.message || 'failed')}`);
  };
  return { reserve: (id, maximum) => command(['reserve', 'memory-classifier', '--provider', 'openrouter', '--cost', String(maximum), '--id', id]), settle: (id, actual) => command(['settle', '--id', id, '--actual', String(Math.ceil(actual * 1_000_000) / 1_000_000)]) };
}

async function withDeadline(action, milliseconds) {
  const controller = new AbortController(); let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Memory classifier timed out')); }, milliseconds); });
  try { return await Promise.race([action(controller.signal), deadline]); }
  finally { clearTimeout(timer); }
}

/** Two deterministic candidate boundaries surround optional provider classification. */
export async function classifyMemory(event, { project, home = userHome(), provider = openRouterClassify, authorization = ledgerAuthorization(project, home), env = process.env } = {}) {
  let modelCalls = 0; let costUsd = 0; let costKnown = true; let text = ''; let runId; let reserved = false; let status = 'ok'; let error;
  const started = Date.now();
  try {
    const user = await jsonFile(resolve(home, '.geppetto/config.json'), {}); const local = await jsonFile(resolve(project, '.geppetto/config.json'), {});
    const settings = { ...user.hooks?.memoryClassifier, ...local.hooks?.memoryClassifier };
    if (settings.enabled !== true) return {};
    if (!env.OPENROUTER_API_KEY) throw new Error('Memory classifier key is absent from the environment or secret store');
    validateSettings(settings);
    if (typeof event.prompt !== 'string' || !event.prompt.trim()) throw new Error('Memory classifier prompt is missing');
    const memory = await memorySettings(project, home);
    if (!memory) throw new Error('Memory is not configured');
    const catalog = await memoryCatalog(memory);
    const candidates = catalog.filter(bucket => bucket.name.toLowerCase() !== 'private' && (bucket.scope === 'global' || memory.buckets.includes(bucket.name))).map(bucket => ({ id: bucket.name, description: bucket.description }));
    if (!candidates.length) return {};
    runId = `memory-classifier:${randomUUID()}`;
    await authorization.reserve(runId, settings.maxCostUsd);
    reserved = true;
    const request = async (stage, choices, signal) => {
      if (signal.aborted) throw new Error('Memory classifier timed out');
      modelCalls++;
      const priorCostsKnown = costKnown; costKnown = false;
      const result = await provider({ stage, model: settings.model, prompt: event.prompt, candidates: choices, apiKey: env.OPENROUTER_API_KEY, signal, maxOutputTokens: settings.maxOutputTokens });
      if (signal.aborted) throw new Error('Memory classifier timed out');
      if (typeof result.costUsd === 'number' && Number.isFinite(result.costUsd) && result.costUsd >= 0) { costUsd += result.costUsd; costKnown = priorCostsKnown; }
      return selections(result, choices, stage === 'buckets' ? settings.bucketThreshold : settings.pageThreshold);
    };
    await withDeadline(async signal => {
      const selected = new Set((await request('buckets', candidates, signal)).map(entry => entry.id));
      const pages = [];
      for (const bucket of candidates.filter(candidate => selected.has(candidate.id))) pages.push(...indexedPages(await memoryIndex(memory, bucket.id), bucket.id));
      if (!pages.length || signal.aborted) return;
      const chosen = await request('pages', pages, signal);
      if (chosen.length) text = `You may want to check out:\n${chosen.sort((a, b) => a.id.localeCompare(b.id, 'en')).map(entry => `- ${entry.id} — ${redact(entry.reason).replace(/\s+/g, ' ').trim()}`).join('\n')}`;
    }, settings.timeoutMs);
  } catch (failure) { text = ''; status = 'error'; error = redact(failure.message).replace(/\s+/g, ' '); }
  if (reserved && costKnown) {
    try { await authorization.settle(runId, costUsd); }
    catch (failure) { text = ''; status = 'error'; error = redact(failure.message).replace(/\s+/g, ' '); }
  }
  await logHookEvent(project, { hook: 'memoryClassifier', event: 'UserPromptSubmit', status, modelCalls, costUsd: costKnown ? costUsd : null, reservationId: reserved ? runId : undefined, injectedBytes: Buffer.byteLength(text), durationMs: Date.now() - started, ...(error ? { error } : {}) });
  return text ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } } : {};
}
