import { open, unlink, appendFile, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cli, isMain, parseArgs, UsageError, jsonFile, userHome } from './common.mjs';

const scale = 1_000_000;
function dollars(text) {
  if (!/^\d+(?:\.\d{1,6})?$/.test(text) || !Number.isSafeInteger(Math.round(Number(text) * scale))) throw new UsageError('Cost must be nonnegative USD with at most six decimals');
  return Math.round(Number(text) * scale);
}

/** Paid OpenRouter requests share accounting; subscription CLIs use no authorization file. */
export async function main(args) {
  const opts = parseArgs(args, { values: ['--cost', '--id', '--actual', '--provider'] });
  const [command, capability] = opts._;
  if (!['check', 'reserve', 'settle', 'list'].includes(command)) throw new UsageError('Usage: authz.mjs check|reserve <capability> --cost <USD|none> [--id <id>]; settle --id <id> --actual <USD>; list');
  if (['check', 'reserve'].includes(command) && (!capability || opts['--cost'] === undefined)) throw new UsageError('Capability and cost are required');
  if (['reserve', 'settle'].includes(command) && !/^[a-z\d_.:-]+$/i.test(opts['--id'] ?? '')) throw new UsageError('A run ID is required');
  const cost = command === 'settle' ? dollars(opts['--actual'] ?? '') : opts['--cost'] === 'none' ? null : dollars(opts['--cost'] ?? '0');
  const directory = resolve(userHome(), '.geppetto'), ledger = resolve(directory, 'api-usage.jsonl');
  let lock;
  if (['reserve', 'settle'].includes(command)) { await mkdir(directory, { recursive: true }); lock = await open(`${ledger}.lock`, 'wx', 0o600); }
  try {
    let entries = [];
    try { entries = (await readFile(ledger, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Invalid API usage file'); }
    const runs = new Map();
    for (const entry of entries) {
      if (typeof entry.id !== 'string' || !entry.id || (!('reserved' in entry) && !runs.has(entry.id)) || ['reserved', 'actual'].some(key => key in entry && !(key === 'reserved' && entry[key] === null) && (!Number.isSafeInteger(entry[key]) || entry[key] < 0))) throw new Error('Invalid API usage record');
      runs.set(entry.id, { ...runs.get(entry.id), ...entry });
    }
    if (command === 'list') { console.log(JSON.stringify({ ledger: [...runs.values()] })); return 0; }
    const append = entry => appendFile(ledger, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    if (command === 'settle') {
      const previous = runs.get(opts['--id']); if (!previous) throw new Error('Unknown paid request');
      if (previous.actual !== undefined && previous.actual !== cost) throw new Error('Paid request already settled');
      if (previous.actual === undefined) await append({ id: opts['--id'], actual: cost });
      console.log('allow API cost recorded'); return 0;
    }
    if (!process.env.OPENROUTER_API_KEY || (opts['--provider'] && opts['--provider'] !== 'openrouter')) { console.log('deny Add OPENROUTER_API_KEY'); return 1; }
    const api = (await jsonFile(resolve(directory, 'config.json'), {})).api ?? {};
    if (api.spendCapUsd != null) {
      const cap = dollars(String(api.spendCapUsd));
      if (cost === null || [...runs.values()].some(run => run.actual === undefined && run.reserved === null) || [...runs.values()].reduce((sum, run) => sum + (run.actual ?? run.reserved), 0) + cost > cap) { console.log('deny OpenRouter spend cap reached or a request has unknown cost'); return 1; }
    }
    if (command === 'reserve') {
      if (runs.has(opts['--id'])) throw new Error('Paid request ID already exists');
      await append({ id: opts['--id'], capability, reserved: cost });
    }
    console.log('allow OpenRouter key present'); return 0;
  } finally { if (lock) { await lock.close(); await unlink(`${ledger}.lock`); } }
}
if (isMain(import.meta.url)) await cli(main);
