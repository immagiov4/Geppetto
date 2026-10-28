import { readFileSync } from 'node:fs';
import { readFile, appendFile, writeFile, unlink, lstat, open } from 'node:fs/promises';
import { resolve, matchesGlob } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cli, isMain, hookMain, run, UsageError, projectRoot, jsonFile, atomicJson, ignoreLocalFiles, gitOutput, reviewGateDefaults, parseArgs } from './common.mjs';
import { logHookEvent } from './hook-events.mjs';
import { redact } from './signal.mjs';
import { learningEvent } from './learn-nudge.mjs';
import { nativeMemoryEvent } from './memory-hook.mjs';
import { placeholderReason } from './gate-sections.mjs';
function words(command) {
  return [...command.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s]+)/g)].map(m => m[1] !== undefined ? m[1].replace(/\\(["\\])/g, '$1') : m[2] ?? m[3]);
}
function option(tokens, names) {
  for (let i = 0; i < tokens.length; i++) {
    if (names.includes(tokens[i])) return tokens[i + 1];
    for (const name of names) if (tokens[i].startsWith(`${name}=`)) return tokens[i].slice(name.length + 1);
  }
}
function sectionFeedback(body, cwd, runCommand) {
  const result = runCommand(process.execPath, [fileURLToPath(new URL('./gate-sections.mjs', import.meta.url)), '--pr', '-'], { cwd, input: body });
  if (result.status === 0) return 'Geppetto: PR sections pass.';
  return `Geppetto PR feedback: ${redact(result.stderr?.trim() || result.error?.message || 'Section check failed')}. Update the PR body before publishing; CI repeats this check.`;
}
const digest = text => createHash('sha256').update(text).digest('hex');
const turnStatePath = (root, session) => resolve(root, '.geppetto/hook-state', `review-turn-${digest(session)}.json`);
const decisionPath = (root, session, turn) => resolve(root, '.geppetto/hook-state', `decision-${digest(session)}-${digest(turn)}.json`);
function turnDecision(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UsageError('Turn decision must be an object.');
  if (value.continuation === true && Object.keys(value).length === 1) return value;
  if (Object.keys(value).length !== 3 || ['requirements', 'feedback', 'frustration'].some(key => !Object.hasOwn(value, key))) throw new UsageError('Turn decision needs requirements, feedback and frustration; review is filled by the gate.');
  for (const [key, flag, reasons] of [['requirements', 'changes', ['what']], ['feedback', 'applies', ['on', 'action']], ['frustration', 'applies', ['cause', 'prevention']]]) {
    const section = value[key];
    if (!section || typeof section[flag] !== 'boolean' || Object.keys(section).some(name => ![flag, ...reasons].includes(name))) throw new UsageError(`Turn ${key}.${flag} must be boolean with its declared fields.`);
    for (const name of reasons) if ((section[flag] || name in section) && (typeof section[name] !== 'string' || /[\r\n]/.test(section[name]) || section[flag] && placeholderReason(section[name]))) throw new UsageError(`Turn ${key}.${name} needs a meaningful one-line reason.`);
  }
  return value;
}
export async function recordTurn(root, session, turn, value) {
  value = turnDecision(value);
  const state = await jsonFile(turnStatePath(root, session), null);
  if (!state || state.turn !== turn) throw new UsageError('No matching active session and turn; use the command supplied by Stop.');
  await atomicJson(decisionPath(root, session, turn), value, { mode: 0o600 }); return value;
}
const reviewPolicy = async root => ({ ...reviewGateDefaults, ...(await jsonFile(resolve(root, '.geppetto/config.json'), {})).hooks?.reviewGate });
/** Only hashes leave this function: line fingerprints permit later comparisons without retaining source. */
async function reviewSnapshot(root, base, policy) {
  const git = args => gitOutput(root, args, { trim: false });
  const excluded = [...policy.docGlobs, ...policy.testGlobs, '.geppetto/**', '.git/**'];
  const files = [...new Set(git(['ls-files', '-c', '-o', '--exclude-standard', '-z']).split('\0').filter(Boolean))].sort();
  const snapshot = [], changedPaths = []; let patch = '';
  const changed = new Set(git(['diff', '--name-only', '--no-renames', '-z', base, '--']).split('\0').filter(Boolean));
  const untracked = new Set(git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean));
  for (const name of new Set([...files, ...changed])) {
    if (name.startsWith('.geppetto/') || name.startsWith('.git/') || excluded.some(glob => matchesGlob(name, glob))) continue;
    if (changed.has(name)) changedPaths.push(name);
    const path = resolve(root, name); let contents = Buffer.alloc(0);
    try { if (!(await lstat(path)).isFile()) continue; contents = await readFile(path); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    if (contents.includes(0)) continue;
    const text = contents.toString('utf8').replaceAll('\r\n', '\n');
    for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) snapshot.push(digest(`${name}\0${line}`));
    if (untracked.has(name)) patch += `${name}\0${digest(contents)}\n`;
  }
  return { hash: digest((changedPaths.length ? git(['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', base, '--', ...changedPaths]) : '') + patch), snapshot: snapshot.length ? `${snapshot.join('\n')}\n` : '' };
}
async function changedLines(root, before, after) {
  if (before === after) return 0;
  const prefix = resolve(root, '.geppetto/hook-state', randomUUID());
  try {
    await writeFile(`${prefix}.before`, before); await writeFile(`${prefix}.after`, after);
    const result = run('git', ['diff', '--no-index', '--numstat', '--', `${prefix}.before`, `${prefix}.after`], { cwd: root });
    if (![0, 1].includes(result.status)) throw new Error('Review line comparison failed.');
    return result.stdout.split('\t').slice(0, 2).reduce((sum, count) => sum + Number(count || 0), 0);
  } finally { for (const suffix of ['before', 'after']) await unlink(`${prefix}.${suffix}`).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export async function recordReview(root, base, outcome) {
  if (!['passed', 'findings'].includes(outcome)) throw new UsageError('Review outcome must be passed or findings after independent review completes.');
  base = gitOutput(root, ['rev-parse', '--verify', `${base}^{commit}`]);
  await ignoreLocalFiles(root, ['/reviews.jsonl', '/hook-state/']);
  const current = await reviewSnapshot(root, base, await reviewPolicy(root));
  await atomicJson(resolve(root, '.geppetto/hook-state', `review-${base}-${current.hash}.json`), current.snapshot);
  const record = { hash: current.hash, base, ts: new Date().toISOString(), outcome };
  await appendFile(resolve(root, '.geppetto/reviews.jsonl'), `${JSON.stringify(record)}\n`, { mode: 0o600 }); return record;
}
async function completionEvent(event) {
  const kind = event.hook_event_name;
  if (process.env.GEPPETTO_LEARNING_CHILD === '1' || !event.session_id || !['UserPromptSubmit', 'PreToolUse', 'Stop'].includes(kind)) return {};
  const root = await projectRoot(event.cwd ?? '.'); const policy = await reviewPolicy(root);
  if (run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root }).status !== 0) return {};
  if (!Number.isSafeInteger(policy.threshold) || policy.threshold <= 0 || ![policy.docGlobs, policy.testGlobs].every(globs => Array.isArray(globs) && globs.every(glob => typeof glob === 'string'))) throw new UsageError('Invalid hooks.reviewGate threshold or globs.');
  const statePath = turnStatePath(root, event.session_id);
  let state = await jsonFile(statePath, null);
  if (kind === 'UserPromptSubmit' || !state || event.turn_id && state.turn !== event.turn_id) {
    await ignoreLocalFiles(root, ['/turns.jsonl', '/reviews.jsonl', '/hook-state/']);
    const base = gitOutput(root, ['rev-parse', 'HEAD']);
    state = { turn: event.turn_id ?? randomUUID(), base, ...(await reviewSnapshot(root, base, policy)) };
    await atomicJson(statePath, state); if (kind !== 'Stop') return {};
  }
  if (kind !== 'Stop' || !state) return {};
  let reviews = '';
  try { reviews = await readFile(resolve(root, '.geppetto/reviews.jsonl'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const records = reviews.trim().split('\n').filter(Boolean).map(JSON.parse), last = records.at(-1);
  const current = await reviewSnapshot(root, last?.base ?? state.base, policy);
  const lines = await changedLines(root, state.snapshot, current.snapshot);
  const reviewed = last && await jsonFile(resolve(root, '.geppetto/hook-state', `review-${last.base}-${last.hash}.json`), null);
  const sinceReview = reviewed === null || reviewed === undefined ? lines : await changedLines(root, reviewed, current.snapshot);
  let status = 'below-threshold';
  if (records.some(record => record.base === last.base && record.hash === current.hash)) status = 'reviewed';
  else if (policy.enabled && lines >= policy.threshold && sinceReview >= policy.threshold) status = 'block';
  if (status === 'block') for (const record of records.slice(0, -1).reverse()) {
    if (await jsonFile(resolve(root, '.geppetto/hook-state', `review-${record.base}-${record.hash}.json`), null) === current.snapshot && (await reviewSnapshot(root, record.base, policy)).hash === record.hash) { status = 'reviewed'; break; }
  }
  if (status === 'block' && /(?:Independent review blocked|Revisione indipendente bloccata):\s*\S.+/i.test(event.last_assistant_message ?? '')) status = 'blocker';
  const value = await jsonFile(decisionPath(root, event.session_id, state.turn), null);
  const decision = value && turnDecision(value), missing = !decision;
  const reasons = [];
  if (missing) reasons.push(`Record requirements, feedback and frustration with node "${fileURLToPath(import.meta.url).replaceAll('\\', '/')}" --record-turn '<json>' --session ${JSON.stringify(event.session_id)} --turn ${JSON.stringify(state.turn)} from the project root (use --record-turn - for JSON stdin). Read the schema and decision procedure in "${fileURLToPath(new URL('../assets/templates/hooks/README.md', import.meta.url)).replaceAll('\\', '/')}" under Turn record.`);
  if (status === 'block') reasons.push('Code changed without an independent review: run $geppetto-verify, or state the concrete blocker in your reply.');
  let block = reasons.length > 0 && !event.stop_hook_active;
  const blockPath = `${statePath}.${digest(state.turn)}.blocked`;
  if (block) {
    try { const claim = await open(blockPath, 'wx', 0o600); try { await claim.writeFile(status); } finally { await claim.close(); } }
    catch (error) { if (error.code !== 'EEXIST') throw error; block = false; }
  }
  if (status === 'block' && !block) status = 'second-stop';
  await logHookEvent(root, { hook: 'reviewGate', status, lines, sinceReview, hash: current.hash }, event);
  await logHookEvent(root, { hook: 'turnGate', status: missing ? (block ? 'block' : 'missing') : 'recorded' }, event);
  if (decision && !block) {
    const marker = `${decisionPath(root, event.session_id, state.turn)}.recorded`; let claim;
    try { claim = await open(marker, 'wx', 0o600); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (claim) try {
      const transcriptOffset = event.transcript_path ? (await lstat(event.transcript_path)).size : null;
      await appendFile(resolve(root, '.geppetto/turns.jsonl'), `${JSON.stringify({ ...decision, review: { status, lines, sinceReview, hash: current.hash }, sessionId: event.session_id, turnId: state.turn, ts: new Date().toISOString(), transcriptOffset })}\n`, { mode: 0o600 });
    } catch (error) { await unlink(marker); throw error; } finally { await claim.close(); }
  }
  let review_blocked = false;
  try { review_blocked = (await readFile(blockPath, 'utf8')) === 'block'; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...(block ? { decision: 'block', reason: reasons.join('\n') } : {}), review_blocked };
}
export async function handleEvent(event, { runCommand = run, now = Date.now, home, launchLearning } = {}) {
  if (!event || typeof event !== 'object') throw new UsageError('Hook input must be an event object');
  const { review_blocked, ...review } = await completionEvent(event);
  const learning = review.decision === 'block' ? {} : await learningEvent({ ...event, review_blocked }, now, launchLearning);
  const native = await nativeMemoryEvent(event, { home });
  if (event.hook_event_name === 'UserPromptSubmit') return {};
  if (native.hookSpecificOutput) {
    if (learning.hookSpecificOutput) native.hookSpecificOutput.additionalContext += `\n${learning.hookSpecificOutput.additionalContext}`;
    return native;
  }
  if (['PostToolUse', 'Stop'].includes(event.hook_event_name)) return review.decision ? review : learning;
  if (typeof event.tool_name !== 'string' || !event.tool_input) throw new UsageError('Hook input needs tool_name and tool_input');
  const input = event.tool_input;
  const eventName = event.hook_event_name ?? 'PreToolUse';
  const command = typeof input === 'string' ? input : input.command ?? input.cmd ?? '';
  const cwd = resolve(input.cwd ?? input.workdir ?? event.cwd ?? '.');
  if (/\bgh\s+pr\s+create\b/.test(command)) {
    const tokens = words(command); const bodyFile = option(tokens, ['--body-file', '-F']); const body = option(tokens, ['--body', '-b']);
    let feedback;
    if (bodyFile && bodyFile !== '-') {
      try { feedback = sectionFeedback(readFileSync(resolve(cwd, bodyFile), 'utf8'), cwd, runCommand); }
      catch (error) { feedback = `Geppetto: PR body file could not be checked (${error.code ?? 'read error'}). Run gate-sections.mjs --pr <file> before creating the PR.`; }
    } else if (body !== undefined) feedback = sectionFeedback(body, cwd, runCommand);
    else feedback = 'Geppetto: provide --body-file <file> and run gate-sections.mjs --pr <file> before creating the PR. CI checks the final PR body.';
    return { hookSpecificOutput: { hookEventName: eventName, additionalContext: feedback } };
  }
  if (/\bgit\s+(?:-[^\s]+\s+)*push\b/.test(command)) {
    const pr = runCommand('gh', ['pr', 'view', '--json', 'body'], { cwd });
    let feedback = 'Geppetto: current PR body is unavailable. Run gate-sections.mjs --pr <body-file> before pushing; CI checks the final PR body.';
    if (pr.status === 0) {
      try { const body = JSON.parse(pr.stdout).body; if (typeof body === 'string') feedback = sectionFeedback(body, cwd, runCommand); }
      catch { feedback = 'Geppetto: gh returned an unreadable PR body; run gate-sections.mjs --pr <body-file>. CI checks the final PR body.'; }
    }
    return { hookSpecificOutput: { hookEventName: eventName, additionalContext: feedback } };
  }
  return {};
}
export const main = async args => {
  if (!args.length) return hookMain(args, 'Hook', handleEvent);
  const opts = parseArgs(args, { flags: ['--record-review'], values: ['--base', '--outcome', '--record-turn', '--session', '--turn'] });
  if (opts['--record-turn'] && opts['--session'] && opts['--turn'] && Object.keys(opts).length === 4) {
    let value; try { value = JSON.parse(opts['--record-turn'] === '-' ? readFileSync(0, 'utf8') : opts['--record-turn']); } catch { throw new UsageError('Turn decision must be JSON.'); }
    console.log(JSON.stringify(await recordTurn(await projectRoot('.'), opts['--session'], opts['--turn'], value))); return 0;
  }
  if (!opts['--record-review'] || !opts['--base'] || !opts['--outcome'] || opts._.length) throw new UsageError('Usage: hook.mjs --record-review --base <ref> --outcome <passed|findings>');
  console.log(JSON.stringify(await recordReview(await projectRoot('.'), opts['--base'], opts['--outcome']))); return 0;
};
if (isMain(import.meta.url)) await cli(main);
