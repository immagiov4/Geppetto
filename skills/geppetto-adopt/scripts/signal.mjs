import { userTurnDecision } from './turn-checks.mjs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { cli, isMain, parseArgs, UsageError, jsonFile, projectRoot, learningPolicy, appendRecord, launchLearning } from './common.mjs';
export { learningDefaults, learningPolicy } from './common.mjs';
export async function localRecords(root, name) {
  try { return (await readFile(resolve(root, `.geppetto/${name}.jsonl`), 'utf8')).split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
export async function signalArchive(root) {
  const grouped = new Map();
  for (const row of await localRecords(root, 'signals')) {
    const key = row.key ?? row.id; if (!key) continue; const before = grouped.get(key), sessions = new Set(before?.sessions ?? []);
    if (row.session) sessions.add(row.session);
    grouped.set(key, { ...before, ...row, key, legacy: row.session && row.key ? false : before?.legacy ?? !row.key, status: row.status === 'resolved' && row.through && before?.id !== row.through ? 'open' : row.status ?? before?.status ?? 'open', sessions: [...sessions], source: before?.source === 'user' ? 'user' : row.source ?? before?.source });
  }
  for (const row of grouped.values()) if (row.status.startsWith('merged-into:')) {
    let target = grouped.get(row.status.slice('merged-into:'.length)); const visited = new Set([row.key]);
    while (target?.status.startsWith('merged-into:') && !visited.has(target.key)) { visited.add(target.key); target = grouped.get(target.status.slice('merged-into:'.length)); }
    if (target && visited.has(target.key)) throw new Error('Cyclic evidence merge; inspect signals.jsonl.');
    if (target) { target.sessions = [...new Set([...target.sessions, ...row.sessions])]; if (row.source === 'user') target.source = 'user'; }
  }
  return [...grouped.values()].sort((a, b) => a.key.localeCompare(b.key, 'en')); }
export async function eligibleSignals(root) {
  const policy = learningPolicy(await jsonFile(resolve(root, '.geppetto/config.json'), {})), open = (await signalArchive(root)).filter(row => row.status === 'open' && !row.legacy);
  return open.filter(row => row.source === 'user' || row.sessions.length >= policy.minSessions || open.length > policy.maxOpenKeys); }
export async function resolveSignals(root, keys, change) {
  for (const key of keys) await appendRecord(root, 'signals', { ...change, key, status: 'resolved', ts: new Date().toISOString(), through: change.through?.[key] });
}
/** Maintenance merges exact keys or proposes a supported class; the curator judges shared meaning. */
export async function maintainEvidence(root, { action, keys, category, reason }) {
  const archive = await signalArchive(root), selected = archive.filter(row => keys?.includes(row.key));
  if (!reason?.trim() || !Array.isArray(keys) || new Set(keys).size !== keys.length || selected.length !== keys.length) throw new UsageError('Maintenance needs existing unique keys and a reason.');
  if (action === 'merge' && keys.length === 2 && selected.every(row => row.status === 'open' && !row.legacy)) {
    await appendRecord(root, 'signals', { key: keys[0], status: `merged-into:${keys[1]}`, ts: new Date().toISOString(), reason: redact(reason) }); return;
  }
  if (action !== 'category' || keys.length < 3 || selected.some(row => row.category !== 'other' || !['open', 'resolved'].includes(row.status)) || new Set(selected.flatMap(row => row.sessions)).size < 2) throw new UsageError('A category needs at least three other keys across distinct sessions.');
  const path = resolve(root, '.geppetto/config.json'), config = await jsonFile(path, {}), policy = learningPolicy(config);
  learningPolicy({ categories: [...policy.categories, category] });
  await appendRecord(root, 'category-proposals', { category, reason: redact(reason), evidence: keys, ts: new Date().toISOString() });
}
export async function recordSignal(root, input, { launch } = {}) {
  const policy = learningPolicy(await jsonFile(resolve(root, '.geppetto/config.json'), {})), allowed = [...policy.categories.map(row => row.id), 'other'];
  if (!allowed.includes(input.category)) throw new UsageError(`Unknown category. Choose: ${allowed.join(', ')}`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.key ?? '') || !input.session?.trim() || !input.text?.trim()) throw new UsageError('Signal needs a slug key, session and text.');
  if (input.category === 'other' && !input.evidence?.trim()) throw new UsageError('other requires concrete evidence.');
  if (input.attributes !== undefined && (!input.attributes || typeof input.attributes !== 'object' || Array.isArray(input.attributes))) throw new UsageError('Secondary effects must be an attributes object.');
  const hash = text => createHash('sha256').update(text).digest('hex'), sessionHash = hash(input.session); const active = await jsonFile(resolve(root, '.geppetto/hook-state', `review-turn-${sessionHash}.json`), {}); const decision = active.turn && (!input.turn || active.turn === input.turn) ? await jsonFile(resolve(root, '.geppetto/hook-state', `decision-${sessionHash}-${hash(active.turn)}.json`), {}) : {}; const turn = userTurnDecision(decision.decisions?.length ? decision : (await localRecords(root, 'turns')).findLast(row => row.sessionId === input.session && (!input.turn || row.turnId === input.turn)));
  const flagged = turn?.feedback?.applies === true || turn?.frustration?.applies === true, source = input.source ?? (flagged ? 'user' : 'agent');
  if (!['user', 'agent'].includes(source) || source === 'user' && !flagged) throw new UsageError('source must agree with the flagged feedback/frustration in the turn record.');
  const previous = (await signalArchive(root)).find(row => row.key === input.key);
  if (previous?.category && previous.category !== input.category) throw new UsageError(`Key ${previous.key} uses category ${previous.category}; maintenance owns category changes.`);
  if (previous?.status.startsWith('merged-into:')) throw new UsageError(`Use ${previous.status.slice('merged-into:'.length)} instead.`);
  if (previous?.status === 'open' && previous.sessions.includes(input.session)) return { duplicate: true, key: input.key };
  const clean = value => typeof value === 'string' ? redact(value) : Array.isArray(value) ? value.map(clean) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clean(child)])) : value; const entry = clean({ ...input, transcript_path: active.transcript_path, source, id: randomUUID(), ts: new Date().toISOString(), status: 'open' });
  await appendRecord(root, 'signals', entry);
  if (policy.enabled !== false && process.env.GEPPETTO_LEARNING_CHILD !== '1' && (await eligibleSignals(root)).some(row => row.key === input.key)) await (launch ?? launchLearning)({ cwd: root, session_id: input.session, turn_id: input.turn ?? active.turn, transcript_path: active.transcript_path, signal_qualified: true });
  return entry; }
export function redact(text) {
  return text.replace(/\b(?:sk-(?:proj-|or-v1-)?[a-z\d_-]{12,}|gh[pousr]_[a-z\d_]{12,}|github_pat_[a-z\d_]{12,}|AKIA[A-Z\d]{16})\b/gi, '[REDACTED]')
    .replace(/\b(Bearer)\s+[^\s"']+/gi, '$1 [REDACTED]')
    .replace(/\b([a-z\d_]*(?:api[_-]?key|token|secret|password))["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}
export async function main(args) {
  const opts = parseArgs(args, { values: ['--category', '--scope', '--kind', '--key', '--session', '--source', '--turn', '--evidence', '--attributes', '--merge', '--reason'], flags: ['--list', '--maintenance'] }); const root = await projectRoot('.');
  if (opts['--list'] && !opts._.length) { console.log(JSON.stringify((await signalArchive(root)).filter(row => row.status === 'open' && !row.legacy).map(row => row.key))); return 0; }
  if (opts['--merge'] && opts['--maintenance'] && opts['--key'] && opts['--reason']?.trim()) { await maintainEvidence(root, { action: 'merge', keys: [opts['--key'], opts['--merge']], reason: opts['--reason'] }); return 0; }
  const kind = opts['--kind'] ?? 'friction';
  if (opts._.length !== 1 || !['error', 'friction', 'preference', 'optimisation'].includes(kind)) throw new UsageError('Usage: signal.mjs "<text>" --key <slug> --session <id> --category <id> [--evidence <reference>] | --list');
  let attributes; try { if (opts['--attributes']) attributes = JSON.parse(opts['--attributes']); } catch { throw new UsageError('--attributes must be a JSON object.'); }
  const entry = await recordSignal(root, { text: opts._[0], kind, scope: opts['--scope'] ?? 'project', key: opts['--key'], session: opts['--session'], category: opts['--category'], source: opts['--source'], turn: opts['--turn'], evidence: opts['--evidence'], attributes });
  console.log(`Signal ${entry.duplicate ? 'already counted' : 'recorded'}: ${entry.key}`); return 0;
}
if (isMain(import.meta.url)) await cli(main);
