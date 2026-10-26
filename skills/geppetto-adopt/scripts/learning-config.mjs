import { existsSync } from 'node:fs';
import { delimiter, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonFile, run, signalLearningDefaults, userHome } from './common.mjs';

export async function learningPolicy(root) {
  const configured = (await jsonFile(resolve(root, '.geppetto/config.json'), {})).hooks?.signalLearning;
  const defaults = signalLearningDefaults();
  // Existing explicit policies keep their billing identity; a missing policy uses subscription defaults.
  if (configured?.provider && configured.billing === undefined) return configured;
  return { ...defaults, ...configured, hosts: Object.fromEntries(['codex', 'claude'].map(name => [name, { ...defaults.hosts[name], ...configured?.hosts?.[name] }])) };
}

/** Resolve npm's JS entry point on Windows without invoking a .cmd shell. */
export function learningCommand(name, configured = {}, env = process.env) {
  const dirs = (env.PATH ?? '').split(delimiter);
  if (configured.executable) {
    const candidates = isAbsolute(configured.executable) ? [configured.executable] : dirs.flatMap(dir => [resolve(dir, configured.executable), resolve(dir, `${configured.executable}.exe`)]);
    const executable = candidates.find(existsSync);
    return executable ? { executable, prefix: configured.prefix ?? [] } : null;
  }
  for (const dir of dirs) {
    const direct = resolve(dir, process.platform === 'win32' ? `${name}.exe` : name);
    if (existsSync(direct)) return { executable: direct, prefix: [] };
    const entry = name === 'codex' ? resolve(dir, 'node_modules/@openai/codex/bin/codex.js') : resolve(dir, 'node_modules/@anthropic-ai/claude-code/cli.js');
    if (existsSync(entry)) return { executable: process.execPath, prefix: [entry] };
  }
  return null;
}

export function subscriptionEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(?:OPENAI_API_KEY|OPENAI_BASE_URL|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_.*|OPENROUTER_API_KEY|T3_.*)$/i.test(key)));
}

/** Configuration controls shared by audit readiness and native launch preflight. */
export function learningHostControlGap(policy, { boundary, provider, budgetControl, billing } = {}) {
  if (!boundary || boundary !== policy.boundary) return 'Host privacy/write boundary is unconfirmed';
  if (!provider || provider !== policy.provider) return 'Host provider routing has not been confirmed against the grant';
  if (billing !== 'subscription' && (policy.assessmentMaxUsd !== undefined || policy.investigationMaxUsd !== undefined) && !budgetControl) return 'Native host budget enforcement has not been verified against the maximum';
  return null;
}

export async function probeLearningHost(policy, { runCommand = run, env = process.env, cwd } = {}) {
  const names = policy.host === 'claude' ? ['claude'] : ['codex', 'claude'];
  for (const name of names) {
    const command = learningCommand(name, policy.hosts?.[name], env);
    if (!command) continue;
    const result = runCommand(command.executable, [...command.prefix, ...(name === 'codex' ? ['login', 'status'] : ['auth', 'status'])], { cwd, env: subscriptionEnvironment(env) });
    let authenticated = false;
    if (name === 'codex') authenticated = result.status === 0 && /logged in using ChatGPT/i.test(`${result.stdout}\n${result.stderr}`);
    else {
      try { const auth = JSON.parse(result.stdout); authenticated = result.status === 0 && auth.loggedIn === true && ['claude.ai', 'oauth_token'].includes(auth.authMethod); } catch { /* An unsupported status format is not subscription proof. */ }
    }
    if (!authenticated) return { available: false, host: name, action: `Run ${name === 'codex' ? 'codex login' : 'claude auth login'} with your subscription account, then rerun adoption.` };
    return { available: true, host: name, ...command };
  }
  return { available: false, action: 'Install Codex CLI and run codex login with your subscription account, then rerun adoption.' };
}

export async function learningReadiness(root, options) {
  const policy = await learningPolicy(root);
  if (!policy.enabled) return { enabled: false, action: 'Signal learning is declined in hooks.signalLearning.enabled.' };
  if (policy.billing !== 'subscription') {
    const host = policy.host ?? 'codex';
    if (!learningCommand(host, policy.hosts?.[host], options?.env)) return { enabled: false, action: `Install the configured ${host} CLI, then rerun adoption.` };
    if (policy.provider === 'openrouter' && !(options?.env ?? process.env).OPENROUTER_API_KEY) return { enabled: false, action: 'Add OPENROUTER_API_KEY to the learning hook launcher through its secret store, then rerun adoption.' };
    const gap = learningHostControlGap(policy, { ...policy.hosts?.[host], billing: policy.billing });
    if (gap) return { enabled: false, action: gap };
    for (const phase of ['assessment', 'investigation']) {
      const home = options?.home ?? userHome();
      const grant = run(process.execPath, [fileURLToPath(new URL('./authz.mjs', import.meta.url)), 'check', `signal-${phase}`, '--cost', policy[`${phase}MaxUsd`] ?? 'none', '--provider', policy.provider], { cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home } });
      if (grant.status !== 0) return { enabled: false, action: 'Record the accepted standing signal-assessment/signal-investigation grants in user and project authorizations, matching any configured cap.' };
    }
    return { enabled: true, host, billing: policy.billing ?? 'api', action: null };
  }
  const probe = await probeLearningHost(policy, { ...options, cwd: root });
  if (!probe.available) return { enabled: false, ...probe };
  const grant = run(process.execPath, [fileURLToPath(new URL('./authz.mjs', import.meta.url)), 'check', 'signal-learning', '--cost', '0', '--provider', probe.host], { cwd: root, env: { ...process.env, HOME: options?.home ?? userHome(), USERPROFILE: options?.home ?? userHome() } });
  return { enabled: grant.status === 0, ...probe, action: grant.status === 0 ? null : 'Accept subscription signal learning in the adoption question round; record its standing project grant with learning-setup.mjs --accept.' };
}
