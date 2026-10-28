import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isAbsolute, resolve } from 'node:path';
import { cli, isMain, parseArgs, UsageError } from './common.mjs';
import { learningCommand } from './learn-runner.mjs';
const requestTimeoutMs = 30000;
const usage = 'Usage: codex-hook-trust.mjs --project <dir> [--plugin <id> | --source <hooks-file> | --key <key>...] [--approve] [--json]';
/** A short-lived Codex protocol connection; it never starts a thread or model turn. */
export function connectCodex({ cwd, command = learningCommand('codex'), env = process.env, timeoutMs = requestTimeoutMs } = {}) {
  if (!command) throw new Error('Codex CLI is unavailable; install it and retry hook approval.');
  const child = spawn(command.executable, [...command.prefix, 'app-server', '--stdio'], { cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 0;
  let failure;
  function fail(error) {
    failure ??= error;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(failure); }
    pending.clear();
  }
  const exited = new Promise(done => child.once('close', done));
  child.once('error', () => fail(new Error('Codex app-server could not start.')));
  child.once('exit', code => fail(new Error(`Codex app-server exited before completing the request (${code ?? 'signal'}).`)));
  child.stdin.on('error', () => fail(new Error('Codex app-server input closed.')));
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); }
    catch { fail(new Error('Codex app-server returned invalid JSON.')); child.kill(); return; }
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.error) request.reject(new Error(`Codex ${request.method} failed: ${message.error.message ?? 'unsupported request'}`));
    else request.resolve(message.result);
  });
  function request(method, params) {
    if (failure) return Promise.reject(failure);
    return new Promise((resolveRequest, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { fail(new Error(`Codex ${method} timed out.`)); child.kill(); }, timeoutMs);
      pending.set(id, { resolve: resolveRequest, reject, timer, method });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  return {
    request,
    async initialize() {
      await request('initialize', { clientInfo: { name: 'geppetto-hook-trust', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
    },
    async close() {
      fail(new Error('Codex hook approval connection closed.'));
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 1000);
      await exited; clearTimeout(timer); lines.close();
    },
    interrupt() { fail(new Error('Codex hook approval interrupted.')); child.kill(); }
  };
}
const samePath = (left, right) => process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
async function inventory(client, project) {
  const response = await client.request('hooks/list', { cwds: [project] });
  if (!Array.isArray(response?.data) || response.data.length !== 1 || !samePath(response.data[0].cwd, project)) throw new Error('Codex hooks/list returned an unexpected project inventory.');
  const entry = response.data[0];
  if (!Array.isArray(entry.hooks) || !Array.isArray(entry.errors) || !Array.isArray(entry.warnings)) throw new Error('Codex hook inventory is incomplete.');
  if (entry.errors.length) throw new Error('Codex could not read all hook definitions; fix the errors shown by /hooks before approving.');
  const keys = new Set();
  for (const hook of entry.hooks) {
    if (typeof hook.key !== 'string' || !hook.key || keys.has(hook.key) || typeof hook.currentHash !== 'string' || !hook.currentHash || typeof hook.enabled !== 'boolean' || typeof hook.isManaged !== 'boolean' || typeof hook.sourcePath !== 'string' || !isAbsolute(hook.sourcePath) || !['untrusted', 'modified', 'trusted', 'managed'].includes(hook.trustStatus)) throw new Error('Codex returned invalid hook metadata.');
    keys.add(hook.key);
  }
  return entry;
}
function select(hooks, { plugin, source, keys }) {
  if (plugin) return hooks.filter(hook => hook.pluginId === plugin);
  if (source) return hooks.filter(hook => samePath(hook.sourcePath, source));
  if (keys?.length) {
    const selected = hooks.filter(hook => keys.includes(hook.key));
    if (new Set(keys).size !== selected.length) throw new Error('Some selected hook keys are unavailable; list hooks again before approving.');
    return selected;
  }
  return hooks;
}
const fingerprint = hooks => JSON.stringify(hooks.map(({ key, currentHash, enabled, isManaged }) => ({ key, currentHash, enabled, isManaged })).sort((a, b) => a.key.localeCompare(b.key, 'en')));
/** Persist only the selected current definitions, then ask Codex to verify their trust. */
export async function hookTrust(client, { project, plugin, source, keys, approve = false }) {
  const selectors = [Boolean(plugin), Boolean(source), Boolean(keys?.length)].filter(Boolean).length;
  if (selectors > 1 || (approve && selectors !== 1)) throw new UsageError('Approval needs exactly one scope: --plugin, --source or --key.');
  const entry = await inventory(client, project);
  const hooks = select(entry.hooks, { plugin, source, keys });
  if (selectors && !hooks.length) throw new Error('No hooks matched. Check the plugin ID, registered source and project trust in /hooks.');
  const result = { project, approved: 0, hooks, warnings: entry.warnings };
  if (!approve) return result;
  const candidates = hooks.filter(hook => hook.enabled && !hook.isManaged && hook.trustStatus !== 'trusted');
  if (!candidates.length) return result;
  const current = await inventory(client, project);
  const selected = select(current.hooks, { plugin, source, keys });
  if (fingerprint(hooks) !== fingerprint(selected)) throw new Error('Selected hook definitions changed during approval; inspect them again and retry.');
  const written = await client.request('config/batchWrite', { edits: candidates.map(hook => ({ keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`, value: hook.currentHash, mergeStrategy: 'upsert' })) });
  if (written?.status !== 'ok') throw new Error('Codex did not confirm the hook approval write.');
  const verified = await inventory(client, project);
  const after = select(verified.hooks, { plugin, source, keys });
  if (fingerprint(hooks) !== fingerprint(after) || candidates.some(hook => !after.some(check => check.key === hook.key && check.trustStatus === 'trusted'))) throw new Error('Hook approval verification failed; list current hooks before retrying.');
  return { ...result, approved: candidates.length, hooks: after, warnings: [...new Set([...entry.warnings, ...current.warnings, ...verified.warnings])] };
}
export async function main(args) {
  const opts = parseArgs(args, { values: ['--project', '--plugin', '--source'], repeat: ['--key'], flags: ['--approve', '--json', '--help'] });
  if (opts['--help']) { console.log(usage); return 0; }
  if (opts._.length || !opts['--project']) throw new UsageError(usage);
  const options = { project: resolve(opts['--project']), plugin: opts['--plugin'], source: opts['--source'] && resolve(opts['--source']), keys: opts['--key'], approve: Boolean(opts['--approve']) };
  const selectors = [options.plugin, options.source, options.keys?.length].filter(Boolean).length;
  if (selectors > 1 || (options.approve && selectors !== 1)) throw new UsageError('Approval needs exactly one scope: --plugin, --source or --key.');
  const client = connectCodex({ cwd: options.project });
  const interrupt = () => client.interrupt();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    await client.initialize();
    const result = await hookTrust(client, options);
    if (opts['--json']) console.log(JSON.stringify(result));
    else {
      console.log(`Codex hooks: ${result.hooks.length} selected; ${result.approved} approvals saved.`);
      for (const hook of result.hooks) console.log(`${hook.enabled ? '[x]' : '[ ]'} ${hook.trustStatus} ${hook.key}\n  ${hook.currentHash}\n  ${hook.command ?? hook.handlerType}`);
      for (const warning of result.warnings) console.error(`Codex hook warning: ${warning}`);
    }
    return 0;
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    await client.close();
  }
}
if (isMain(import.meta.url)) await cli(main);
