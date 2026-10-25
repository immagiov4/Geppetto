import { readFile, mkdir, open, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { cli, isMain, parseArgs, UsageError, userHome } from './common.mjs';
import { redact } from './signal.mjs';

const USD_SCALE = 1_000_000;
const DAY_MS = 86400000;
const LOCK_WAIT_MS = 5000;
const LOCK_POLL_MS = 25;
function dollars(text) {
  if (!/^\d+(?:\.\d{1,6})?$/.test(String(text))) throw new UsageError('USD must be a nonnegative decimal with at most six decimal places');
  const [whole, fraction = ''] = String(text).split('.');
  const amount = Number(whole) * USD_SCALE + Number(fraction.padEnd(6, '0'));
  if (!Number.isSafeInteger(amount)) throw new UsageError('USD amount is too large');
  return amount;
}

async function grants(file) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const [i, line] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = line.match(/^\s*\[([\w.-]+)\]\s+(.*)$/);
    if (!match) throw new Error(`${file}:${i + 1}: Invalid grant`);
    const fields = {}; const tokens = /([a-z_]+)=(?:"([^"\r\n]*)"|([^\s]+))/g; let end = 0;
    for (const token of match[2].matchAll(tokens)) {
      if (match[2].slice(end, token.index).trim() || token[1] in fields) throw new Error(`${file}:${i + 1}: Invalid or duplicate grant field`);
      fields[token[1]] = token[2] ?? token[3]; end = token.index + token[0].length;
    }
    const required = ['provider', 'budget_usd', 'per', 'scope', 'expires'];
    if (match[2].slice(end).trim() || Object.keys(fields).length !== required.length || required.some(key => !fields[key])) throw new Error(`${file}:${i + 1}: Grant needs provider, budget_usd, per, scope and expires`);
    if (!/^[a-z\d/_.:-]+$/i.test(fields.provider) || !/^[1-9]\d*d$/.test(fields.per) || !/^\d{4}-\d{2}-\d{2}$/.test(fields.expires) || !Number.isFinite(Date.parse(fields.expires)) || new Date(fields.expires).toISOString().slice(0, 10) !== fields.expires) throw new Error(`${file}:${i + 1}: Invalid provider, period or expiry`);
    let budget;
    try { budget = dollars(fields.budget_usd); } catch { throw new Error(`${file}:${i + 1}: Invalid budget_usd`); }
    const periodMs = Number(fields.per.slice(0, -1)) * DAY_MS;
    if (!Number.isSafeInteger(periodMs)) throw new Error(`${file}:${i + 1}: Period is too large`);
    result.push({ capability: match[1], ...fields, budget, periodMs, file, line: i + 1 });
  }
  return result;
}

async function locked(path, action) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`; const started = Date.now(); let handle;
  while (!handle) {
    try { handle = await open(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() - started >= LOCK_WAIT_MS) throw new Error(`${lock}:1: Ledger is busy; inspect the owner before removing a stale lock`);
      await setTimeout(LOCK_POLL_MS);
    }
  }
  try { return await action(); } finally { await handle.close(); await unlink(lock); }
}

async function ledger(path) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
  const runs = new Map();
  const lines = text.split('\n');
  for (const [i, line] of lines.entries()) {
    if (!line && i === lines.length - 1) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { throw new Error(`${path}:${i + 1}: Corrupt ledger; reconcile before spending`); }
    const fail = () => { throw new Error(`${path}:${i + 1}: Invalid ledger event; reconcile before spending`); };
    if (!entry || typeof entry.id !== 'string' || !Number.isFinite(Date.parse(entry.ts))) fail();
    if (entry.type === 'reserve') {
      if (runs.has(entry.id) || typeof entry.capability !== 'string' || typeof entry.project !== 'string' || !Number.isSafeInteger(entry.reserved) || entry.reserved < 0) fail();
      runs.set(entry.id, entry);
    } else if (entry.type === 'settle') {
      const previous = runs.get(entry.id);
      if (!previous || previous.actual !== undefined || !Number.isSafeInteger(entry.actual) || entry.actual < 0) fail();
      previous.actual = entry.actual;
    } else fail();
  }
  return runs;
}

function decide(capability, cost, user, project, runs, projectPath, taskGrant, requestedProvider) {
  const personal = user.filter(g => g.capability === capability);
  if (!personal.length && !taskGrant) return ['ask', 'No personal grant; ask the owner for a standing authorization or use explicit task-scoped consent'];
  const local = project.filter(g => g.capability === capability);
  if (!local.length && !taskGrant) return ['deny', 'Project does not grant this capability'];
  const now = Date.now();
  for (const grant of [...personal, ...local]) {
    if (now >= Date.parse(grant.expires) + DAY_MS) return ['deny', `${grant.file}:${grant.line}: Grant expired`];
    const cutoff = now - grant.periodMs;
    let spent = 0;
    for (const run of runs.values()) {
      if (run.capability !== capability || (local.includes(grant) && run.project !== projectPath)) continue;
      // Pending work keeps its maximum reserved even after the rolling period ends.
      if (run.actual === undefined || Date.parse(run.ts) >= cutoff) spent += run.actual ?? run.reserved;
    }
    if (spent + cost > grant.budget) return ['deny', `${grant.file}:${grant.line}: Budget exhausted ($${spent / USD_SCALE} used or reserved; $${grant.budget / USD_SCALE} limit)`];
  }
  const providers = [...new Set([...personal, ...local].map(g => g.provider).filter(p => p !== 'any'))];
  if (providers.length > 1) return ['deny', 'User and project provider restrictions do not intersect'];
  if (requestedProvider && providers.length && providers[0] !== requestedProvider) return ['deny', `Requested provider ${requestedProvider} is outside the grant's provider restriction`];
  return ['allow', `${taskGrant ? `Explicit task-scoped consent (${redact(taskGrant)}), limited to this invocation's maximum; existing grant limits apply` : 'Within user and project grants'}; provider=${providers[0] ?? 'any'}; scopes=${[...personal, ...local].map(g => g.scope).join(' / ')}; harness permissions still apply`];
}

async function append(path, entry) {
  const handle = await open(path, 'a', 0o600);
  try { await handle.write(`${JSON.stringify(entry)}\n`); await handle.sync(); } finally { await handle.close(); }
}

export async function main(args) {
  const opts = parseArgs(args, { values: ['--cost', '--id', '--actual', '--task-grant', '--provider'] });
  const [command, capability] = opts._;
  const wantsCapability = ['check', 'reserve'].includes(command);
  if (!['check', 'reserve', 'settle', 'list'].includes(command) || opts._.length !== (wantsCapability ? 2 : 1) || (wantsCapability && !/^[\w.-]+$/.test(capability))) throw new UsageError('Usage: authz.mjs check|reserve <capability> --cost <usd> [--id <run-id>] [--task-grant <scope>]; settle --id <run-id> --actual <usd>; list');
  const allowed = { check: ['--cost'], reserve: ['--cost', '--id'], settle: ['--id', '--actual'], list: [] }[command];
  const optional = wantsCapability ? ['--task-grant', '--provider'] : [];
  if (allowed.some(k => opts[k] === undefined) || Object.keys(opts).some(k => k !== '_' && ![...allowed, ...optional].includes(k))) throw new UsageError(`Invalid options for ${command}`);
  const taskGrant = opts['--task-grant'];
  const provider = opts['--provider'];
  if (provider !== undefined && !/^[a-z\d/_.:-]+$/i.test(provider)) throw new UsageError('Provider must be a provider identifier');
  if (taskGrant !== undefined && (!taskGrant.trim() || /[\r\n]/.test(taskGrant))) throw new UsageError('Task grant must name the explicit current-request scope on one nonempty line');
  if (opts['--id'] !== undefined && !/^[a-z\d_.:-]{1,200}$/i.test(opts['--id'])) throw new UsageError('Run ID must contain 1-200 letters, digits, dots, colons, underscores or hyphens');
  const cost = wantsCapability ? dollars(opts['--cost']) : command === 'settle' ? dollars(opts['--actual']) : 0;
  const projectPath = resolve('.'); const userDir = resolve(userHome(), '.geppetto'); const ledgerPath = resolve(userDir, 'ledger.jsonl');
  const action = async () => {
    const runs = await ledger(ledgerPath);
    if (command === 'list') {
      const personal = await grants(resolve(userDir, 'authorizations')); const local = await grants(resolve(projectPath, '.geppetto/authorizations'));
      console.log(JSON.stringify({ user: personal, project: local, ledger: [...runs.values()] }, null, 2)); return 0;
    }
    if (command === 'settle') {
      const previous = runs.get(opts['--id']);
      if (!previous) throw new Error('Unknown reservation ID');
      if (previous.actual !== undefined && previous.actual !== cost) throw new Error('Reservation already settled with a different cost');
      if (previous.actual === undefined) await append(ledgerPath, { type: 'settle', id: opts['--id'], ts: new Date().toISOString(), actual: cost });
      console.log(`allow Settled ${opts['--id']} at $${cost / USD_SCALE}`); return 0;
    }
    const previous = runs.get(opts['--id']);
    if (previous) {
      if (previous.capability !== capability || previous.project !== projectPath || previous.reserved !== cost || previous.taskGrant !== (taskGrant ? redact(taskGrant) : undefined) || previous.provider !== provider) throw new Error('Run ID already belongs to a different reservation');
      throw new Error(`Reservation ${opts['--id']} already exists; do not execute the paid work twice`);
    }
    const personal = await grants(resolve(userDir, 'authorizations')); const local = await grants(resolve(projectPath, '.geppetto/authorizations'));
    const [decision, reason] = decide(capability, cost, personal, local, runs, projectPath, taskGrant, provider);
    if (command === 'reserve' && decision === 'allow') await append(ledgerPath, { type: 'reserve', id: opts['--id'], capability, project: projectPath, ts: new Date().toISOString(), reserved: cost, ...(taskGrant ? { taskGrant: redact(taskGrant) } : {}), ...(provider ? { provider } : {}) });
    console.log(`${decision} ${reason}`); return decision === 'allow' ? 0 : 1;
  };
  // Checks observe the ledger; only reservations and settlements need to create a lock.
  return ['check', 'list'].includes(command) ? action() : locked(ledgerPath, action);
}

if (isMain(import.meta.url)) await cli(main);
