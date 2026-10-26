import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicJson, cli, defaultConfig, isMain, jsonFile, parseArgs, UsageError } from './common.mjs';
import { learningPolicy, probeLearningHost } from './learning-config.mjs';

/** Call --accept only for the owner's accepted adoption answer, never for inferred consent. */
export async function adoptLearning(root, { accepted = false, ...options } = {}) {
  const config = await jsonFile(resolve(root, '.geppetto/config.json'), defaultConfig());
  const policy = await learningPolicy(root);
  if (config.pillars?.signalLearning === 'declined' || (!policy.enabled && !accepted)) return { enabled: false, action: 'Preserve the recorded signal-learning decline.' };
  const probe = await probeLearningHost(policy, { ...options, cwd: root });
  if (!probe.available) return { enabled: false, action: probe.action };
  if (!accepted) return { enabled: false, action: 'Ask once in the adoption round: allow subscription signal learning and local branch commits (default yes)?' };
  const path = resolve(root, '.geppetto/authorizations');
  let grants = '';
  try { grants = await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const prior = grants.split(/\r?\n/).find(line => /^\[signal-learning\]/.test(line));
  if (prior && !prior.includes(`provider=${probe.host} `)) throw new Error('Existing learning grant uses another provider; reconcile the adoption answer explicitly');
  if (!prior) {
    await mkdir(resolve(root, '.geppetto'), { recursive: true });
    await appendFile(path, `${grants && !grants.endsWith('\n') ? '\n' : ''}[signal-learning] provider=${probe.host} budget_usd=0 per=1d scope="project signals; file tools; isolated local branches; stage or commit; no publication" expires=never\n`, { mode: 0o600 });
  }
  config.hooks ??= {};
  config.hooks.signalLearning = { ...policy, enabled: true, host: probe.host, provider: probe.host === 'codex' ? 'openai' : 'anthropic', boundary: policy.boundary ?? defaultConfig().hooks.signalLearning.boundary, billing: 'subscription' };
  for (const key of ['assessmentMaxUsd', 'investigationMaxUsd']) if (config.hooks.signalLearning[key] === null) delete config.hooks.signalLearning[key];
  config.pillars ??= {}; config.pillars.signalLearning = 'installed';
  await atomicJson(resolve(root, '.geppetto/config.json'), config);
  return { enabled: true, host: probe.host, action: null };
}

export async function main(args) {
  const opts = parseArgs(args, { values: ['--project'], flags: ['--accept'] });
  if (opts._.length) throw new UsageError('Usage: learning-setup.mjs [--project <root>] [--accept]');
  console.log(JSON.stringify(await adoptLearning(resolve(opts['--project'] ?? '.'), { accepted: opts['--accept'] === true })));
}
if (isMain(import.meta.url)) await cli(main);
