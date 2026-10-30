import { readFileSync } from 'node:fs';
import { readFile, writeFile, unlink, lstat, mkdir } from 'node:fs/promises';
import { resolve, matchesGlob } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { cli, isMain, hookMain, run, UsageError, projectRoot, jsonFile, atomicJson, ignoreLocalFiles, gitOutput, reviewGateDefaults, parseArgs, claimFile, appendRecord, exists } from './common.mjs';
import { logHookEvent, logReads } from './hook-events.mjs';
import { compileIntegrations } from './maintenance.mjs';
import { redact, localRecords } from './signal.mjs';
import { learningEvent } from './learn-nudge.mjs';
import { nativeMemoryEvent, handleMemoryEvent } from './memory-hook.mjs';
import { placeholderReason } from './gate-sections.mjs';
import { turnPolicy, decisionFields, toolCommand, modifyingTool, reviewResult, commandArgs } from './turn-checks.mjs';
function sectionFeedback(body, cwd, runCommand) {
  const result = runCommand(process.execPath, [fileURLToPath(new URL('./gate-sections.mjs', import.meta.url)), '--pr', '-'], { cwd, input: body });
  if (result.status === 0) return 'Geppetto: PR sections pass.';
  return `Geppetto PR feedback: ${redact(result.stderr?.trim() || result.error?.message || 'Section check failed')}. Update the PR body before publishing; CI repeats this check.`; }
const digest = text => createHash('sha256').update(text).digest('hex');
const turnStatePath = (root, session) => resolve(root, '.geppetto/hook-state', `review-turn-${digest(session)}.json`);
const decisionPath = (root, session, turn) => resolve(root, '.geppetto/hook-state', `decision-${digest(session)}-${digest(turn)}.json`);
const currentState = state => state && typeof state.turn === 'string' && typeof state.epoch === 'string' && typeof state.worktree === 'string' && typeof state.base === 'string' && typeof state.snapshot === 'string' ? state : null;
const currentDecision = decision => decision && typeof decision.epoch === 'string' && decision.value && Array.isArray(decision.decisions) && decision.decisions.length ? decision : null;
async function worktreeFingerprint(root) {
  const status = gitOutput(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.', ':(exclude).geppetto/.gitignore'], { trim: false }); const gitRoot = gitOutput(root, ['rev-parse', '--show-toplevel']), hash = createHash('sha256').update(status), entries = status.split('\0').filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i], name = entry.slice(3); if (/[RC]/.test(entry.slice(0, 2))) i++; const stat = await lstat(resolve(gitRoot, name), { bigint: true }).catch(error => { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; });
    if (stat) hash.update(`${name}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}\n`);
  } return hash.digest('hex');
}
async function sessionStart(event, options) {
  const memory = await handleMemoryEvent(event, options); if (!event.session_id) return memory; const root = await projectRoot(event.cwd ?? '.');
  await compileIntegrations(root, options);
  if (run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root }).status !== 0) return memory;
  const policy = turnPolicy(await jsonFile(resolve(root, '.geppetto/config.json'), {})); if (!policy.checks.length) return memory;
  await ignoreLocalFiles(root, ['/hook-state/']); await mkdir(resolve(root, '.geppetto/hook-state'), { recursive: true });
  if (!await claimFile(`${turnStatePath(root, event.session_id)}.startup`)) return memory;
  const schema = Object.fromEntries(policy.checks.map(({ id }) => [id, { [decisionFields(id)[0]]: false }])); const text = `Before the first file-modifying tool call of a turn, record decisions from the project root: ${recordCommand(event.session_id)} (active turn resolved automatically; --record-turn - reads JSON stdin). Edit-free turns need no record.\nMinimal schema: ${JSON.stringify(schema)}.\n${policy.checks.map(({ id, question, skill }) => `${id}: ${question} If true, apply $${skill}; supply meaningful one-line ${decisionFields(id).slice(1).join(' and ')}.`).join('\n')}\nJudge incoming work before editing. On review-result re-arm, record feedback again before the next edit. Set optional userCorrection to true only if this user message corrects the preceding work, false otherwise; this calibrates audit without text heuristics. For a pure continuation use {"continuation":true}; renewed feedback still needs evaluation. Review is filled by the gate.`;
  try { await logHookEvent(root, { hook: 'turnContext', status: 'injected', injectedBytes: Buffer.byteLength(text), modelCalls: 0 }, event); }
  catch (error) { await unlink(`${turnStatePath(root, event.session_id)}.startup`); throw error; }
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: [memory.hookSpecificOutput?.additionalContext, text].filter(Boolean).join('\n') } }; }
const recordCommand = (session, turn) => `node "${fileURLToPath(import.meta.url).replaceAll('\\', '/')}" --record-turn '<json>' --session ${JSON.stringify(session)}${turn ? ` --turn ${JSON.stringify(turn)}` : ''}`;
function turnDecision(value, checks) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UsageError('Turn decision must be an object.');
  if (value.userCorrection !== undefined && typeof value.userCorrection !== 'boolean') throw new UsageError('userCorrection must be boolean.');
  if (value.continuation === true && Object.keys(value).every(key => ['continuation', 'userCorrection'].includes(key))) return value;
  if (Object.keys(value).some(key => key !== 'userCorrection' && !checks.some(check => check.id === key)) || checks.some(check => !Object.hasOwn(value, check.id))) throw new UsageError(`Turn decision needs ${checks.map(check => check.id).join(', ')}; review is filled by the gate.`);
  for (const { id } of checks) {
    const [flag, ...reasons] = decisionFields(id), section = value[id];
    if (!section || typeof section[flag] !== 'boolean' || Object.keys(section).some(name => ![flag, ...reasons].includes(name))) throw new UsageError(`Turn ${id}.${flag} must be boolean with its declared fields.`);
    for (const name of reasons) if ((section[flag] || name in section) && (typeof section[name] !== 'string' || /[\r\n]/.test(section[name]) || section[flag] && placeholderReason(section[name]))) throw new UsageError(`Turn ${id}.${name} needs a meaningful one-line reason.`);
  }
  return value; }
export async function recordTurn(root, session, turn, value) {
  const state = currentState(await jsonFile(turnStatePath(root, session), null)); turn ??= state?.turn;
  if (!state || state.turn !== turn) throw new UsageError('No matching active session and turn; use the command supplied by PreToolUse.');
  const { checks } = turnPolicy(await jsonFile(resolve(root, '.geppetto/config.json'), {})); const path = decisionPath(root, session, turn), previous = currentDecision(await jsonFile(path, null)), renewed = state.epoch !== 'initial' && previous !== null; const required = renewed ? checks.filter(check => check.id === 'feedback') : checks;
  if (renewed && value?.continuation) throw new UsageError('Renewed feedback requires an explicit decision.');
  turnDecision(value, renewed && value && Object.keys(value).every(key => ['feedback', 'userCorrection'].includes(key)) ? required : checks);
  const decidedAt = new Date().toISOString(); let requestedAt = decidedAt;
  try { requestedAt = await readFile(`${path}.${state.epoch}.requested`, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const merged = renewed ? { ...previous?.value, ...value } : value; if (renewed) delete merged.continuation; const history = previous?.epoch === state.epoch ? previous.decisions.slice(0, -1) : previous?.decisions ?? []; const decisions = [...history, { requestedAt, decidedAt, decision: merged }];
  await atomicJson(path, { value: merged, epoch: state.epoch, decisions }, { mode: 0o600 }); return merged;
}
async function editingEvent(root, state, statePath, event, policy) {
  const path = decisionPath(root, event.session_id, state.turn), staged = currentDecision(await jsonFile(path, null));
  if (event.hook_event_name === 'PostToolUse') {
    const worktree = await worktreeFingerprint(root);
    if (worktree !== state.worktree) {
      await claimFile(`${path}.edited`); if (staged?.epoch !== state.epoch) state.shellPending = state.epoch;
      state.worktree = worktree; await atomicJson(statePath, state);
    }
    if (policy.checks.some(check => check.id === 'feedback') && reviewResult(event, policy) && (!event.tool_use_id || await claimFile(`${path}.${digest(event.tool_use_id)}.received`))) {
      const epoch = randomUUID(); await atomicJson(statePath, { ...state, epoch, ...(state.shellPending === state.epoch ? { shellPending: epoch } : {}) }); await logHookEvent(root, { hook: 'turnGate', status: 'rearmed' }, event);
    } return {};
  }
  if (!modifyingTool(event) && state.shellPending !== state.epoch) return {};
  if (policy.checks.length && staged?.epoch !== state.epoch && await claimFile(`${path}.${state.epoch}.requested`, new Date().toISOString())) {
    const needed = !staged || state.epoch === 'initial' ? policy.checks : policy.checks.filter(check => check.id === 'feedback');
    await logHookEvent(root, { hook: 'turnGate', status: 'block', checks: needed.map(check => check.id) }, event);
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Before editing, record ${needed.map(check => check.id).join(', ')} with ${recordCommand(event.session_id, state.turn)} from the project root. ${needed.map(({ id, question, skill }) => `${id}: ${question} Apply $${skill} if true; fields: ${decisionFields(id).join(', ')}.`).join(' ')} Use the SessionStart schema or Turn record in "${fileURLToPath(new URL('../assets/templates/hooks/README.md', import.meta.url))}".` } };   }
  await claimFile(`${path}.edited`); return {};
}
const reviewPolicy = async root => ({ ...reviewGateDefaults, ...(await jsonFile(resolve(root, '.geppetto/config.json'), {})).hooks?.reviewGate });
async function diffDigest(root, args, suffix) {
  const hash = createHash('sha256');
  await new Promise((done, reject) => {
    const child = spawn('git', args, { cwd: root, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); let stderr = '';
    child.stdout.on('data', chunk => hash.update(chunk)); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('close', code => code === 0 ? done() : reject(new Error(`Git diff failed: ${stderr.trim() || code}`)));
  });
  return hash.update(suffix).digest('hex'); }
/** Only hashes leave this function: line fingerprints permit later comparisons without retaining source. */
async function reviewSnapshot(root, base, policy) {
  const git = args => gitOutput(root, args, { trim: false }); const excluded = [...policy.docGlobs, ...policy.testGlobs, '.geppetto/**', '.git/**']; const files = [...new Set(git(['ls-files', '-c', '-o', '--exclude-standard', '-z']).split('\0').filter(Boolean))].sort(); const snapshot = [], changedPaths = []; let patch = ''; const changed = new Set(git(['diff', '--name-only', '--no-renames', '-z', base, '--']).split('\0').filter(Boolean)); const untracked = new Set(git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean));
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
  return { hash: changedPaths.length ? await diffDigest(root, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', base, '--', ...changedPaths], patch) : digest(patch), snapshot: snapshot.length ? `${snapshot.join('\n')}\n` : '' }; }
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
  base = gitOutput(root, ['rev-parse', '--verify', `${base}^{commit}`]); await ignoreLocalFiles(root, ['/reviews.jsonl', '/hook-state/']);
  const current = await reviewSnapshot(root, base, await reviewPolicy(root));
  await atomicJson(resolve(root, '.geppetto/hook-state', `review-${base}-${current.hash}.json`), current.snapshot);
  const record = { hash: current.hash, base, ts: new Date().toISOString(), outcome };
  await appendRecord(root, 'reviews', record); return record;
}
async function completionEvent(event) {
  const kind = event.hook_event_name;
  if (process.env.GEPPETTO_LEARNING_CHILD === '1' || !event.session_id || !['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].includes(kind)) return {};
  const root = await projectRoot(event.cwd ?? '.'); const policy = await reviewPolicy(root);
  if (run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root }).status !== 0) return {};
  if (!Number.isSafeInteger(policy.threshold) || policy.threshold <= 0 || ![policy.docGlobs, policy.testGlobs].every(globs => Array.isArray(globs) && globs.every(glob => typeof glob === 'string'))) throw new UsageError('Invalid hooks.reviewGate threshold or globs.');
  const statePath = turnStatePath(root, event.session_id); let state = currentState(await jsonFile(statePath, null));
  if (kind === 'UserPromptSubmit' || !state || event.turn_id && state.turn !== event.turn_id) {
    await ignoreLocalFiles(root, ['/turns.jsonl', '/reviews.jsonl', '/hook-state/', '/hook-events.jsonl']);
    const base = gitOutput(root, ['rev-parse', 'HEAD']);
    state = { transcript_path: event.transcript_path ? resolve(event.cwd ?? root, event.transcript_path) : state?.transcript_path, turn: event.turn_id ?? randomUUID(), previousTurnId: state?.turn ?? null, epoch: 'initial', base, worktree: await worktreeFingerprint(root), ...(await reviewSnapshot(root, base, policy)) };
    await atomicJson(statePath, state); if (kind === 'UserPromptSubmit') return {};
  }
  if (event.transcript_path && state.transcript_path !== event.transcript_path) { state.transcript_path = resolve(event.cwd ?? root, event.transcript_path); await atomicJson(statePath, state); }
  if (policy.enabled === false) return {}; if (['PreToolUse', 'PostToolUse'].includes(kind)) return editingEvent(root, state, statePath, event, turnPolicy(await jsonFile(resolve(root, '.geppetto/config.json'), {})));
  if (kind !== 'Stop') return {};
  const records = []; for (const record of await localRecords(root, 'reviews', { currentWorktree: true })) if (await exists(resolve(root, '.geppetto/hook-state', `review-${record.base}-${record.hash}.json`))) records.push(record);
  const last = records.at(-1); const current = await reviewSnapshot(root, last?.base ?? state.base, policy); const lines = await changedLines(root, state.snapshot, current.snapshot); const reviewed = last && await jsonFile(resolve(root, '.geppetto/hook-state', `review-${last.base}-${last.hash}.json`), null); const sinceReview = reviewed === null || reviewed === undefined ? lines : await changedLines(root, reviewed, current.snapshot);
  let status = 'below-threshold';
  if (records.some(record => record.base === last.base && record.hash === current.hash)) status = 'reviewed';
  else if (policy.enabled && lines >= policy.threshold && sinceReview >= policy.threshold) status = 'block';
  if (status === 'block') for (const record of records.slice(0, -1).reverse()) {
    if (await jsonFile(resolve(root, '.geppetto/hook-state', `review-${record.base}-${record.hash}.json`), null) === current.snapshot && (await reviewSnapshot(root, record.base, policy)).hash === record.hash) { status = 'reviewed'; break; }
  }
  if (status === 'block' && /(?:Independent review blocked|Revisione indipendente bloccata):\s*\S.+/i.test(event.last_assistant_message ?? '')) status = 'blocker';
  const staged = currentDecision(await jsonFile(decisionPath(root, event.session_id, state.turn), null)); const reasons = status === 'block' ? ['Code changed without an independent review: run $geppetto-verify, or state the concrete blocker in your reply.'] : [];
  let block = reasons.length > 0 && !event.stop_hook_active; const blockPath = `${statePath}.${digest(state.turn)}.blocked`;
  if (block) block = await claimFile(blockPath, status);
  if (status === 'block' && !block) status = 'second-stop';
  await logHookEvent(root, { hook: 'reviewGate', status, lines, sinceReview, hash: current.hash }, event);
  if (staged && !block) {
    const marker = `${decisionPath(root, event.session_id, state.turn)}.recorded`; if (await claimFile(marker)) try {
      const transcriptOffset = event.transcript_path ? (await lstat(event.transcript_path)).size : null; const decisions = staged.decisions, first = decisions[0]; const edited = await lstat(`${decisionPath(root, event.session_id, state.turn)}.edited`).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
      await appendRecord(root, 'turns', { ...staged.value, requestedAt: first.requestedAt, decidedAt: first.decidedAt, decisions, edited, addedSeconds: decisions.reduce((sum, d) => sum + Math.max(0, Date.parse(d.decidedAt) - Date.parse(d.requestedAt)) / 1000, 0), review: { status, lines, sinceReview, hash: current.hash }, sessionId: event.session_id, turnId: state.turn, previousTurnId: state.previousTurnId, ts: new Date().toISOString(), transcriptOffset });
      await logHookEvent(root, { hook: 'turnGate', status: 'recorded' }, event);
    } catch (error) { await unlink(marker); throw error; }
  }
  let review_blocked = false; try { review_blocked = (await readFile(blockPath, 'utf8')) === 'block'; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...(block ? { decision: 'block', reason: reasons.join('\n') } : {}), review_blocked }; }
async function dispatch(event, { runCommand = run, now = Date.now, home, launchLearning } = {}) {
  if (!event || typeof event !== 'object') throw new UsageError('Hook input must be an event object');
  if (process.env.GEPPETTO_LEARNING_CHILD !== '1') await logReads(event, { home });
  if (event.hook_event_name === 'SessionStart') return process.env.GEPPETTO_LEARNING_CHILD === '1' ? {} : sessionStart(event, { home });
  const { review_blocked, ...review } = await completionEvent(event);
  if (review.hookSpecificOutput?.permissionDecision === 'deny') return review;
  const learning = review.decision === 'block' ? {} : await learningEvent({ ...event, review_blocked }, now, launchLearning); const native = await nativeMemoryEvent(event, { home }); if (event.hook_event_name === 'UserPromptSubmit') return {};
  if (native.hookSpecificOutput) {
    if (learning.hookSpecificOutput) native.hookSpecificOutput.additionalContext += `\n${learning.hookSpecificOutput.additionalContext}`;
    return native;   }
  if (['PostToolUse', 'Stop'].includes(event.hook_event_name)) return review.decision ? review : learning;
  if (typeof event.tool_name !== 'string' || !event.tool_input) throw new UsageError('Hook input needs tool_name and tool_input');
  const input = event.tool_input, eventName = event.hook_event_name ?? 'PreToolUse'; const command = toolCommand(event); const cwd = resolve(input.cwd ?? input.workdir ?? event.cwd ?? '.');
  if (/\bgh\s+pr\s+create\b/.test(command)) {
    const { flags } = commandArgs(command), bodyFile = flags.get('--body-file') ?? flags.get('-F'), body = flags.get('--body') ?? flags.get('-b');
    let feedback;
    if (bodyFile && bodyFile !== '-') {
      try { feedback = sectionFeedback(readFileSync(resolve(cwd, bodyFile), 'utf8'), cwd, runCommand); }
      catch (error) { feedback = `Geppetto: PR body file could not be checked (${error.code ?? 'read error'}). Run gate-sections.mjs --pr <file> before creating the PR.`; }
    } else if (body !== undefined) feedback = sectionFeedback(body, cwd, runCommand);
    else feedback = 'Geppetto: provide --body-file <file> and run gate-sections.mjs --pr <file> before creating the PR. CI checks the final PR body.';
    return { hookSpecificOutput: { hookEventName: eventName, additionalContext: feedback } };   }
  if (/\bgit\s+(?:-[^\s]+\s+)*push\b/.test(command)) {
    const pr = runCommand('gh', ['pr', 'view', '--json', 'body'], { cwd });
    let feedback = 'Geppetto: current PR body is unavailable. Run gate-sections.mjs --pr <body-file> before pushing; CI checks the final PR body.';
    if (pr.status === 0) {
      try { const body = JSON.parse(pr.stdout).body; if (typeof body === 'string') feedback = sectionFeedback(body, cwd, runCommand); }
      catch { feedback = 'Geppetto: gh returned an unreadable PR body; run gate-sections.mjs --pr <body-file>. CI checks the final PR body.'; }
    }
    return { hookSpecificOutput: { hookEventName: eventName, additionalContext: feedback } };   }
  return {}; }
export async function handleEvent(event, options) {
  try { return await dispatch(event, options); }
  catch (error) {
    if (['PreToolUse', 'PostToolUse'].includes(event?.hook_event_name)) { console.error(`Geppetto ${event.hook_event_name} diagnostic: ${redact(error.message).replace(/[\r\n]+/g, ' ')}`); return {}; }
    if (event?.hook_event_name !== 'Stop') throw error;
    try {
      const root = await projectRoot(event.cwd ?? '.'); const statePath = turnStatePath(root, event.session_id ?? 'unknown');
      const state = await jsonFile(statePath, null).catch(() => null); // Diagnostic recovery must tolerate the broken state itself.
      await ignoreLocalFiles(root, ['/hook-state/']); await mkdir(resolve(root, '.geppetto/hook-state'), { recursive: true });
      const marker = `${statePath}.${digest(event.turn_id ?? state?.turn ?? 'unknown')}.error`; if (await claimFile(marker)) try { await logHookEvent(root, { hook: 'completion', status: 'error', error: redact(error.message) }, event); }
      catch (cause) { await unlink(marker); throw cause; }
    } catch (cause) { console.error(`Stop diagnostic failed: ${redact(cause.message)}; original error: ${redact(error.message)}`); }
    return {};   }
}
export const main = async args => {
  if (!args.length) try { return await hookMain(args, 'Hook', handleEvent); } catch (error) { console.error(`Geppetto hook diagnostic: ${redact(error.message).replace(/[\r\n]+/g, ' ')}`); console.log('{}'); return 0; }
  const opts = parseArgs(args, { flags: ['--record-review'], values: ['--base', '--outcome', '--record-turn', '--session', '--turn'] });
  if (opts['--record-turn'] && opts['--session'] && opts._.length === 0 && Object.keys(opts).every(key => ['_', '--record-turn', '--session', '--turn'].includes(key))) {
    let value; try { value = JSON.parse(opts['--record-turn'] === '-' ? readFileSync(0, 'utf8') : opts['--record-turn']); } catch { throw new UsageError('Turn decision must be JSON.'); }
    console.log(JSON.stringify(await recordTurn(await projectRoot('.'), opts['--session'], opts['--turn'], value))); return 0;
  }
  if (!opts['--record-review'] || !opts['--base'] || !opts['--outcome'] || opts._.length) throw new UsageError('Usage: hook.mjs --record-review --base <ref> --outcome <passed|findings>');
  console.log(JSON.stringify(await recordReview(await projectRoot('.'), opts['--base'], opts['--outcome']))); return 0;
};
if (isMain(import.meta.url)) await cli(main);
