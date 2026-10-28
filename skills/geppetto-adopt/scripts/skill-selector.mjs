import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { jsonFile, userHome, run, skillSelectorDefaults } from './common.mjs';
import { selectSkillBatches } from './skill-batches.mjs';
import { logHookEvent } from './hook-events.mjs';
import { redact } from './signal.mjs';
import { skillCatalog, validateSkillSelectorSettings, suggestSkills } from './skill-catalog.mjs';
import { openRouterSelectSkills } from './skill-provider.mjs';
function selections(result, candidates, threshold) {
  if (!Array.isArray(result.selections)) throw new Error('Classifier selections must be an array');
  const allowed = new Set(candidates.map(candidate => candidate.id)); const seen = new Set();
  for (const entry of result.selections) {
    if (!entry || !allowed.has(entry.id) || seen.has(entry.id) || !Number.isFinite(entry.score) || entry.score < 0 || entry.score > 1 || typeof entry.reason !== 'string' || !entry.reason.trim()) throw new Error('Classifier returned an invalid or out-of-candidate selection');
    seen.add(entry.id);
  }
  return result.selections.filter(entry => entry.score >= threshold);
}

function ledgerAuthorization(project, home) {
  let currentKey;
  const command = args => {
    const result = run(process.execPath, [fileURLToPath(new URL('./authz.mjs', import.meta.url)), ...args], { cwd: project, env: { ...process.env, HOME: home, USERPROFILE: home, OPENROUTER_API_KEY: currentKey } });
    if (result.status !== 0) throw new Error(`Classifier authorization: ${redact(result.stdout?.trim() || result.stderr?.trim() || result.error?.message || 'failed')}`);
  };
  return { reserve: (id, maximum, key) => { currentKey = key; return command(['reserve', 'skill-selector', '--provider', 'openrouter', '--cost', maximum == null ? 'none' : String(maximum), '--id', id]); }, settle: (id, actual) => command(['settle', '--id', id, '--actual', String(Math.ceil(actual * 1_000_000) / 1_000_000)]) };
}

async function withDeadline(action, milliseconds) {
  const controller = new AbortController(); let timer;
  const deadlineAt = performance.now() + milliseconds;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Classifier timed out')); }, milliseconds); });
  try { return await Promise.race([action(controller.signal, deadlineAt), deadline]); }
  catch (error) { controller.abort(); throw error; }
  finally { clearTimeout(timer); }
}

/** Select catalog entries within one authorized deadline and spending reservation. */
export async function classifySkills(event, { project, home = userHome(), provider = openRouterSelectSkills, authorization = ledgerAuthorization(project, home), env = process.env }) {
  let modelCalls = 0; let costUsd = 0; let unknownCosts = 0; let text = ''; let runId; let reserved = false; let status = 'ok'; let error;
  const started = Date.now();
  try {
    const user = await jsonFile(resolve(home, '.geppetto/config.json'), {}); const local = await jsonFile(resolve(project, '.geppetto/config.json'), {});
    const settings = { ...skillSelectorDefaults, ...user.hooks?.skillSelector, ...local.hooks?.skillSelector };
    if (settings.enabled === false) return {};
    if (!env.OPENROUTER_API_KEY) throw new Error('Classifier key is absent from the environment or secret store');
    validateSkillSelectorSettings(settings);
    const candidates = await skillCatalog(project, home, settings, env);
    if (!candidates.length) return {};
    runId = `skill-selector:${randomUUID()}`;
    await authorization.reserve(runId, settings.maxCostUsd, env.OPENROUTER_API_KEY);
    reserved = true;
    const account = cost => { if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) { costUsd += cost; unknownCosts--; } };
    const request = async (choices, signal) => {
      if (signal.aborted) throw new Error('Classifier timed out');
      modelCalls++;
      unknownCosts++;
      let result;
      try { result = await provider({ model: settings.model, prompt: event.prompt, candidates: choices, apiKey: env.OPENROUTER_API_KEY, signal }); }
      catch (failure) { account(failure.costUsd); throw failure; }
      account(result.costUsd);
      if (signal.aborted) throw new Error('Classifier timed out');
      return selections(result, choices, settings.threshold);
    };
    await withDeadline(async (signal, deadlineAt) => {
      const selected = await selectSkillBatches(candidates, { ...settings, prompt: event.prompt }, request, signal, deadlineAt);
      text = suggestSkills(selected, candidates, settings);
    }, settings.timeoutMs);
  } catch (failure) { text = ''; status = 'error'; error = redact(failure.message).replace(/\s+/g, ' '); }
  if (reserved && unknownCosts === 0) {
    try { await authorization.settle(runId, costUsd); }
    catch (failure) { text = ''; status = 'error'; error = redact(failure.message).replace(/\s+/g, ' '); }
  }
  await logHookEvent(project, { hook: 'skillSelector', event: 'UserPromptSubmit', status, modelCalls, costUsd: unknownCosts === 0 ? costUsd : null, reservationId: reserved ? runId : undefined, injectedBytes: Buffer.byteLength(text), durationMs: Date.now() - started, ...(error ? { error } : {}) }, event);
  return text ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } } : {};
}
