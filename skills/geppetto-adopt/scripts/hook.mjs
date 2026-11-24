import { matchingScreenRun, screenChoiceReminder, screenSourceStatus } from './screen-config.mjs';
import { weeklyReportNotice } from './weekly-report.mjs';
import { updateNotice } from './update-check.mjs';
import { captureResources } from './resource-metrics.mjs';
import { readFileSync } from 'node:fs';
import { readFile, writeFile, unlink, lstat, mkdir } from 'node:fs/promises';
import { resolve, relative, matchesGlob, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { completedReviewSession, reviewMaterialSeal } from './review-evidence.mjs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { cli, isMain, hookMain, run, UsageError, projectRoot, userHome, jsonFile, atomicJson, ignoreLocalFiles, gitOutput, reviewGateDefaults, parseArgs, claimFile, appendRecord, recordContext, exists, contained, rejectSymlinks } from './common.mjs';
import { messageCheckpoint, withTurnLock, turnStatePath, readTurnState, decisionPath, currentDecision } from './turn-messages.mjs';
import { logHookEvent, logReads } from './hook-events.mjs';
import { compileIntegrations } from './maintenance.mjs';
import { redact, localRecords, signalArchive, resolveSignals, redactValue, learningPolicy } from './signal.mjs';
import { learningEvent } from './learn-nudge.mjs';
import { nativeMemoryEvent, handleMemoryEvent } from './memory-hook.mjs';
import { placeholderReason } from './gate-sections.mjs';
import { turnPolicy, decisionFields, toolCommand, modifyingTool, reviewResult, commandArgs, commandSegments, userTurnDecision } from './turn-checks.mjs';
import { isAntigravityEvent, normalizeAntigravityEvent, handleAntigravityEvent } from './antigravity.mjs';
function sectionFeedback(body, cwd, runCommand) {
  const result = runCommand(process.execPath, [fileURLToPath(new URL('./gate-sections.mjs', import.meta.url)), '--pr', '-'], { cwd, input: body });
  if (result.status === 0) return 'Geppetto: PR sections pass.';
  return `Geppetto PR feedback: ${redact(result.stderr?.trim() || result.error?.message || 'Section check failed')}. Update the PR body before publishing; CI repeats this check.`; }
const digest = text => createHash('sha256').update(text).digest('hex');
const currentState = state => state && typeof state.turn === 'string' && typeof state.epoch === 'string' && typeof state.worktree === 'string' && typeof state.base === 'string' && typeof state.snapshot === 'string' ? state : null;
async function worktreeFingerprint(root) {
  const status = gitOutput(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.', ':(exclude).geppetto/.gitignore'], { trim: false }); const gitRoot = gitOutput(root, ['rev-parse', '--show-toplevel']), hash = createHash('sha256').update(status), entries = status.split('\0').filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i], name = entry.slice(3); if (/[RC]/.test(entry.slice(0, 2))) i++; const stat = await lstat(resolve(gitRoot, name), { bigint: true }).catch(error => { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; });
    if (stat) hash.update(`${name}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}\n`);
  } return hash.digest('hex');
}
async function learningFiles(root) {
  const files = {};
  for (const name of gitOutput(root, ['ls-files', '-c', '-o', '--exclude-standard', '-z'], { trim: false }).split('\0').filter(Boolean)) {
    const path = resolve(root, name); if (!contained(root, path) || name.startsWith('.geppetto/hook-state/')) continue;
    try { if ((await lstat(path)).isFile()) { await rejectSymlinks(path); files[name.replaceAll('\\', '/')] = digest(await readFile(path)); } }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  return files;
}
async function recordLearning(root, state, statePath, event, learning) {
  if (!learning || !['lesson', 'covered', 'one-off', 'blocked'].includes(learning.outcome) || Object.keys(learning).some(key => !['outcome', 'path', 'reason', 'key'].includes(key)) || typeof learning.reason !== 'string' || /[\r\n]/.test(learning.reason) || placeholderReason(learning.reason)) throw new UsageError('Learning needs outcome and a meaningful one-line reason.');
  if (learning.key !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(learning.key)) throw new UsageError('Learning key must be a slug.');
  if (['lesson', 'covered', 'blocked'].includes(learning.outcome) && (typeof learning.path !== 'string' || !learning.path.trim())) throw new UsageError('Learning needs its owner path.');
  if (['lesson', 'covered'].includes(learning.outcome)) {
    const path = resolve(root, learning.path); if (!contained(root, path) || path === root || relative(root, path).split(/[\\/]/)[0] === '.git') throw new UsageError('Use a project owner; retain external lessons in the project instruction file.');
    await rejectSymlinks(path); if (!(await lstat(path)).isFile()) throw new UsageError('Learning owner must be a file.');
    learning = { ...learning, path: relative(root, path).replaceAll('\\', '/') };
  }
  if (learning.outcome === 'blocked' && !learning.key) throw new UsageError('Blocked learning needs a signal key.');
  if (state.learningOutcome) {
    if (JSON.stringify(state.learningOutcome) !== JSON.stringify(learning)) throw new UsageError('This user turn already has a learning outcome.');
    return learning;
  }
  state.learningOutcome = learning; await atomicJson(statePath, state); return learning;
}
async function finishLearning(root, state, statePath, event) {
  const learning = state.learningOutcome; if (!learning || state.learningRecorded) return;
  const ts = new Date().toISOString();
  if (learning.outcome === 'blocked') {
    const staged = currentDecision(await jsonFile(decisionPath(root, event.session_id, state.turn), null));
    const decision = userTurnDecision({ decisions: staged?.decisions.slice(staged.userDecisionIndex ?? 0) }), source = decision?.frustration?.applies || decision?.feedback?.applies ? 'user' : 'agent';
    const prior = (await signalArchive(root)).find(row => row.key === learning.key), categories = learningPolicy(await jsonFile(resolve(root, '.geppetto/config.json'), {})).categories;
    await appendRecord(root, 'signals', redactValue({ key: learning.key, text: `${learning.path}: ${learning.reason}`, session: event.session_id, turn: state.turn, source, category: prior?.category ?? (categories.some(row => row.id === 'workflow') ? 'workflow' : 'other'), evidence: learning.path, status: 'open', id: randomUUID(), ts, transcript_path: state.transcript_path }));
  }
  else if (learning.key) {
    const signal = (await signalArchive(root)).find(row => row.key === learning.key); if (!signal || signal.status !== 'open') throw new UsageError('Learning key must name an open signal.');
    await resolveSignals(root, [learning.key], { reference: `${event.session_id}:${state.turn}`, reason: learning.reason, paths: learning.path ? [learning.path] : [], through: { [learning.key]: signal.id } });
  }
  await logHookEvent(root, { hook: 'learningOutcome', ...redactValue(learning), userEpoch: state.userEpoch ?? 'initial', ts, modelCalls: 0 }, event);
  state.learningRecorded = true; await atomicJson(statePath, state);
}
async function learningGate(root, state, statePath, event, staged) {
  const marker = `${statePath}.${digest(state.userEpoch ?? state.turn)}.learning-blocked`;
  const retry = await exists(marker);
  const outcome = state.learningOutcome, frustration = staged?.decisions.slice(staged.userDecisionIndex ?? 0).some(row => row.decision.frustration?.applies);
  let reason = frustration && !outcome ? 'Frustration needs a learning outcome in this turn.' : '';
  if (outcome?.outcome === 'lesson') {
    const path = resolve(root, outcome.path); await rejectSymlinks(path);
    if (!state.learningFiles || digest(await readFile(path)) === state.learningFiles[outcome.path]) reason = 'The lesson owner did not change in this user turn.';
    else if (!(outcome.path in state.learningFiles) && run('git', ['check-ignore', '-q', '--', outcome.path], { cwd: root }).status === 0) reason = 'The lesson owner is ignored by Git; write the lesson in a shared project file.';
  }
  if (!reason) {
    await finishLearning(root, state, statePath, event);
    if (frustration) await logHookEvent(root, { hook: 'learningGate', status: 'closed', disposition: 'outcome', retry }, event);
    return {};
  }
  const strict = event.harness === 'codex';
  if (strict && overrideFor(state, 'stop')) {
    await logHookEvent(root, { hook: 'learningGate', status: 'override', disposition: 'override', retry }, event);
    return {};
  }
  const first = (strict || !event.stop_hook_active) && await claimFile(marker);
  const block = strict || first;
  await logHookEvent(root, { hook: 'learningGate', status: block ? 'block' : 'second-stop', disposition: block ? (first ? 'denied' : 'retry-denied') : 'unresolved', retry, reason, modelCalls: 0 }, event);
  return block ? { decision: 'block', reason: `${reason} Edit the project instruction or existing owner, then record ${recordCommand(event.session_id, state.turn)} with {"learning":{"outcome":"lesson|covered|one-off|blocked","path":"<owner>","reason":"<why>","key":"<signal-key when blocked or closing a signal>"}}. A lesson names a file changed now; covered names an existing rule; one-off explains why it cannot recur; blocked names the inaccessible owner and requires a key.${strict ? ` For an explicit override, run ${overrideCommand(event, state, 'stop')} with the real reason.` : ''}` } : {};
}
async function sessionStart(event, options) {
  let memory = await handleMemoryEvent(event, options); if (!event.session_id) return memory; const root = await projectRoot(event.cwd ?? '.');
  const update = await updateNotice(root, { ...options, harness: event.harness });
  const adopted = await exists(resolve(root, '.geppetto/config.json'));
  const hasHead = run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root }).status === 0;
  const [report, screen] = adopted
    ? await Promise.all([weeklyReportNotice(root, options.now()), hasHead ? screenSourceStatus(root, options) : null]) : ['', null];
  const notice = [update, report, screen?.scope === 'unset' && screenChoiceReminder].filter(Boolean).join('\n');
  if (notice) {
    const additionalContext = [memory.hookSpecificOutput?.additionalContext, notice].filter(Boolean).join('\n');
    memory = { ...memory, hookSpecificOutput: { ...memory.hookSpecificOutput, hookEventName: 'SessionStart', additionalContext } };
  }
  await compileIntegrations(root, options);
  if (!hasHead) return memory;
  const policy = turnPolicy(await jsonFile(resolve(root, '.geppetto/config.json'), {})); if (!policy.checks.length) return memory;
  await ignoreLocalFiles(root, ['/hook-state/']); await mkdir(resolve(root, '.geppetto/hook-state'), { recursive: true });
  if (!await claimFile(`${turnStatePath(root, event.session_id)}.startup`)) return memory;
  const schema = Object.fromEntries(policy.checks.map(({ id }) => [id, { [decisionFields(id)[0]]: false }])); const text = `Before the first file-modifying tool call after each user message, record decisions from the project root: ${recordCommand(event.session_id)} (active turn resolved automatically; --record-turn - reads JSON stdin). Edit-free turns need no record unless frustration applies. Close frustration in this turn: edit the owning rule, then use --record-turn with {"learning":{"outcome":"lesson","path":"AGENTS.md","reason":"<concrete prevention>"}}. Other outcomes: covered with existing rule path, one-off with reason, blocked with inaccessible owner path/reason and key. Installed plugin owners belong in the project instruction file instead. Plain steering needs no outcome.\nMinimal schema: ${JSON.stringify(schema)}.\n${policy.checks.map(({ id, question, skill }) => `${id}: ${question} If true, apply $${skill}; supply meaningful one-line ${decisionFields(id).slice(1).join(' and ')}.`).join('\n')}\n${foundationReminder} Judge incoming work before editing. On review-result re-arm, record feedback again before the next edit. Set optional userCorrection to true only if this user message corrects the preceding work, false otherwise; this calibrates audit without text heuristics. For a pure continuation use {"continuation":true}; renewed feedback still needs evaluation. Review is filled by the gate.`;
  try { await logHookEvent(root, { hook: 'turnContext', status: 'injected', injectedBytes: Buffer.byteLength(text), modelCalls: 0 }, event); }
  catch (error) { await unlink(`${turnStatePath(root, event.session_id)}.startup`); throw error; }
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: [memory.hookSpecificOutput?.additionalContext, text].filter(Boolean).join('\n') } }; }
const foundationReminder = 'Resolve foundations.documentation for documentation design and foundations.observability for new or changed behaviour through $geppetto-spec. For every new or changed foundation, apply $geppetto-spec and set requirements.foundation to pending until the user decision is recorded. Then supply its foundations.<key> or project-relative Markdown decision record in an adr/ directory. For substantial work with no foundation, set requirements.foundation to false. For behaviour changes, name the affected metrics and expected budgets.';
const recordCommand = (session, turn) => `node "${fileURLToPath(import.meta.url).replaceAll('\\', '/')}" --record-turn '<json>' --session ${JSON.stringify(session)}${turn ? ` --turn ${JSON.stringify(turn)}` : ''}`;
const overrideFor = (state, gate) => state.overrides?.epoch === state.epoch && state.overrides[gate];
const overrideCommand = (event, state, gate) => recordCommand(event.session_id, state.turn)
  .replace('<json>', JSON.stringify({ override: { gate, reason: '<specific reason>' } }));
function turnDecision(value, checks) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UsageError('Turn decision must be an object.');
  if (value.userCorrection !== undefined && typeof value.userCorrection !== 'boolean') throw new UsageError('userCorrection must be boolean.');
  if (value.continuation === true && Object.keys(value).every(key => ['continuation', 'userCorrection'].includes(key))) return value;
  if (Object.keys(value).some(key => key !== 'userCorrection' && !checks.some(check => check.id === key)) || checks.some(check => !Object.hasOwn(value, check.id))) throw new UsageError(`Turn decision needs ${checks.map(check => check.id).join(', ')}; review is filled by the gate.`);
  for (const { id } of checks) {
    const [flag, ...reasons] = decisionFields(id), section = value[id];
    if (!section || typeof section[flag] !== 'boolean' || Object.keys(section).some(name => ![flag, ...reasons, ...(id === 'requirements' ? ['foundation', 'screenRun'] : [])].includes(name))) throw new UsageError(`Turn ${id}.${flag} must be boolean with its declared fields.`);
    for (const name of reasons) if ((section[flag] || name in section) && (typeof section[name] !== 'string' || /[\r\n]/.test(section[name]) || section[flag] && placeholderReason(section[name]))) throw new UsageError(`Turn ${id}.${name} needs a meaningful one-line reason.`);
  }
  return value; }
export async function recordTurn(root, session, turn, value) { return withTurnLock(`${turnStatePath(root, session)}.lock`, async () => {
  const state = currentState(await readTurnState(root, session, turn)); turn ??= state?.turn;
  if (!state || state.turn !== turn) throw new UsageError('No matching active session and turn; use the command supplied by PreToolUse.');
  if (value && Object.keys(value).length === 1 && (value.learning || value.override)) {
    const statePath = turnStatePath(root, session, state.turn === (await readTurnState(root, session))?.turn ? undefined : turn);
    const event = { session_id: session, turn_id: turn };
    if (value.learning) return recordLearning(root, state, statePath, event, value.learning);
    const { gate, reason } = value.override;
    if (!['edit', 'stop'].includes(gate) || typeof reason !== 'string' || /[\r\n]/.test(reason) || placeholderReason(reason) || ['<specific reason>', 'whatever'].includes(reason.trim().toLowerCase())) {
      throw new UsageError('An override needs gate edit or stop and a meaningful one-line reason.');
    }
    const previous = state.overrides?.epoch === state.epoch ? state.overrides : {};
    state.overrides = { ...previous, epoch: state.epoch, [gate]: reason };
    await recordContext.run({ harness: state.harness ?? null, sessionId: session, turnId: turn, epoch: state.epoch },
      () => logHookEvent(root, { hook: 'gateOverride', gate, disposition: 'recorded', reason: redact(reason) }, event));
    await atomicJson(statePath, state);
    return value.override;
  }
  const { checks } = turnPolicy(await jsonFile(resolve(root, '.geppetto/config.json'), {})); const path = decisionPath(root, session, turn), previous = currentDecision(await jsonFile(path, null)), renewed = state.epoch !== 'initial' && state.epoch !== state.userEpoch && previous !== null; const required = renewed ? checks.filter(check => check.id === 'feedback') : checks;
  if ((renewed || state.epoch === state.userEpoch) && value?.continuation) throw new UsageError('A new user message or renewed feedback requires explicit decisions.');
  turnDecision(value, renewed && value && Object.keys(value).every(key => ['feedback', 'userCorrection'].includes(key)) ? required : checks);
  const requirements = value.requirements;
  if (requirements?.changes && process.env.OPENROUTER_API_KEY) {
    const screening = await screenSourceStatus(root);
    if (screening.shareSource && !await matchingScreenRun(root, requirements.screenRun, session, turn, state.requirementsSince ?? 0)) {
      throw new UsageError('Run the semantic screen through requirements-blast-radius with the current --session, then record requirements.screenRun from its result.');
    }
  }
  const foundation = requirements?.foundation;
  if (requirements?.changes && foundation === undefined) throw new UsageError('Classify requirements.foundation as false, pending, or a decision reference.');
  if (previous && previous.userEpoch === state.userEpoch && previous.value.requirements?.foundation && requirements && !foundation) {
    throw new UsageError('Resolve the declared foundation with a recorded decision before editing.');
  }
  const pending = previous?.userEpoch === state.userEpoch && isPendingFoundation(previous?.value.requirements?.foundation);
  const subject = pending ? previous.value.requirements.what : requirements?.what;
  if (pending && requirements && requirements.what !== subject) throw new UsageError('Keep the pending foundation subject when resolving it.');
  if (foundation && typeof foundation === 'object' && !pendingScope(foundation)) {
    const { adr, approvedDecision } = foundation;
    if (!adrReference(adr) || !validFoundationRecord(approvedDecision, subject)) {
      throw new UsageError('Supply an adr/ Markdown path and a complete user-approved decision record. See the Turn record reference.');
    }
    const destination = resolve(root, adr);
    await rejectSymlinks(destination);
    await mkdir(dirname(destination), { recursive: true });
    const contents = approvedDecision + '\n';
    try { await writeFile(destination, contents, { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!await recordedFoundation(root, adr) || await readFile(destination, 'utf8') !== contents) {
        throw new UsageError('The ADR path already contains another decision; choose a new path.');
      }
    }
    requirements.foundation = adr;
  } else if (foundation !== undefined && foundation !== false && !isPendingFoundation(foundation) && !await recordedFoundation(root, foundation, pending ? subject : undefined)) {
    throw new UsageError('Use pending, a populated foundations.<key>, or an existing project-relative Markdown decision record.');
  }
  const decidedAt = new Date().toISOString(); let requestedAt = decidedAt;
  try { requestedAt = await readFile(`${path}.${state.epoch}.requested`, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const merged = renewed ? { ...previous?.value, ...value } : value; if (renewed) delete merged.continuation; const history = previous?.epoch === state.epoch ? previous.decisions.slice(0, -1) : previous?.decisions ?? []; const decisions = [...history, { requestedAt, decidedAt, epoch: state.epoch, disposition: 'recorded', decision: merged }];
  await atomicJson(path, { value: merged, epoch: state.epoch, userEpoch: state.userEpoch, userDecisionIndex: state.userDecisionIndex ?? 0, decisions }, { mode: 0o600 }); return merged;
}); }
const adrReference = reference => typeof reference === 'string' && /^(?:[\w-]+\/)*adrs?\/[\w-][\w.-]*\.md$/i.test(reference);
const pendingScope = reference => reference && typeof reference === 'object' && Object.keys(reference).length === 1 &&
  Array.isArray(reference.pending) && reference.pending.length > 0 &&
  reference.pending.every(path => typeof path === 'string' && /^[\w.-][\w*?./ -]*$/.test(path) && !path.split('/').includes('..'))
  ? reference.pending : undefined;
const isPendingFoundation = reference => reference === 'pending' || Boolean(pendingScope(reference));

function validFoundationRecord(text, subject) {
  if (typeof text !== 'string') return false;
  const fields = new Map();
  for (const section of text.trim().split(/^## /m).slice(1)) {
    const boundary = section.indexOf('\n');
    if (boundary < 0) return false;
    const heading = section.slice(0, boundary).trim();
    if (fields.has(heading)) return false;
    fields.set(heading, section.slice(boundary + 1).trim());
  }
  const meaningful = value => value && !placeholderReason(value) && !/^for now[.!]?$/i.test(value);
  const required = ['Subject', 'Approval', 'Decision', 'Assumption', 'Inspectability'];
  if (!required.every(heading => meaningful(fields.get(heading))) || subject && fields.get('Subject') !== subject) return false;
  const alternatives = fields.get('Alternatives')?.split(/^### /m).slice(1) ?? [];
  const names = alternatives.map(option => option.split('\n', 1)[0].trim());
  return alternatives.length >= 2 && names.every(meaningful) && new Set(names).size === names.length &&
    alternatives.every(option => ['Pros', 'Cons', 'Risks'].every(label => {
      const line = option.split(/\r?\n/).find(line => line.startsWith('- ' + label + ': '));
      return meaningful(line?.slice(label.length + 4).trim());
    }));
}

function withinPendingScope(root, event, scope) {
  const input = event.tool_input;
  const path = input?.file_path ?? input?.path ?? input?.Path;
  const patch = typeof input === 'string' ? input : input?.patch;
  const move = [input?.source, input?.destination].filter(value => typeof value === 'string');
  const targets = move.length === 2 ? move : typeof path === 'string' ? [path] : typeof patch === 'string'
    ? [...patch.matchAll(/^\*\*\* (?:Add File|Delete File|Update File|Move to): (.+)$/gm)].map(match => match[1]) : [];
  return targets.length === 0 || targets.some(target => {
    const absolute = resolve(event.cwd ?? root, target);
    return contained(root, absolute) && scope.some(glob => matchesGlob(relative(root, absolute).replaceAll('\\', '/'), glob));
  });
}

async function recordedFoundation(root, reference, subject) {
  if (typeof reference !== 'string') return false;
  const key = /^foundations\.([a-z]+)$/.exec(reference)?.[1];
  if (key && !subject) {
    const { foundations } = await jsonFile(resolve(root, '.geppetto/config.json'), {});
    return typeof foundations?.[key] === 'string' && !placeholderReason(foundations[key]);
  }
  if (!adrReference(reference)) return false;
  const path = resolve(root, reference);
  if (!contained(root, path)) return false;
  try {
    await rejectSymlinks(path);
    return (await lstat(path)).isFile() && validFoundationRecord(await readFile(path, 'utf8'), subject);
  } catch (error) {
    if (error.message?.endsWith('Reconcile symbolic link before writing') || ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return false;
    throw error;
  }
}
function isTurnRecorder(event, state) {
  const parts = commandSegments(toolCommand(event)).filter(part => part.trim());
  if (parts.length !== 1) return false;
  const { executable, positional, flags } = commandArgs(parts[0]);
  return /^node$/i.test(executable ?? '') && positional.length === 1 &&
    resolve(event.cwd ?? '.', positional[0]) === fileURLToPath(import.meta.url) &&
    typeof flags.get('--record-turn') === 'string' && flags.get('--session') === event.session_id &&
    (flags.size === 2 || (flags.size === 3 && flags.get('--turn') === state.turn));
}

async function editingEvent(root, state, statePath, event, policy) {
  const path = decisionPath(root, event.session_id, state.turn), staged = currentDecision(await jsonFile(path, null));
  const modifying = modifyingTool(event);
  if (event.hook_event_name === 'PostToolUse') {
    const worktree = await worktreeFingerprint(root);
    if (worktree !== state.worktree) {
      await claimFile(`${path}.edited`);
      if (!modifying && policy.checks.length) {
        const openFoundation = staged?.userEpoch === state.userEpoch && isPendingFoundation(staged?.value.requirements?.foundation);
        const disposition = openFoundation ? 'unchecked'
          : staged?.epoch === state.epoch ? 'decision' : overrideFor(state, 'edit') ? 'override' : 'unchecked';
        if (disposition === 'unchecked') state.shellPending = state.epoch;
        await logHookEvent(root, { hook: 'turnGate', status: 'observed-edit', disposition }, event);
      }
      state.worktree = worktree; await atomicJson(statePath, state);
    }
    if (policy.checks.some(check => check.id === 'feedback') && reviewResult(event, policy) && (!event.tool_use_id || await claimFile(`${path}.${digest(event.tool_use_id)}.received`))) {
      if (state.epoch === state.userEpoch && staged?.epoch !== state.epoch) return {};
      const epoch = randomUUID(); await atomicJson(statePath, { ...state, epoch, ...(state.shellPending === state.epoch ? { shellPending: epoch } : {}) }); await logHookEvent(root, { hook: 'turnGate', status: 'rearmed' }, event);
    } return {};
  }
  if (!modifying && (state.shellPending !== state.epoch || isTurnRecorder(event, state))) return {};
  const foundation = staged?.userEpoch === state.userEpoch ? staged?.value?.requirements?.foundation : undefined;
  const scope = pendingScope(foundation);
  if (foundation && (!scope || withinPendingScope(root, event, scope)) && !await recordedFoundation(root, foundation)) {
    await logHookEvent(root, { hook: 'turnGate', status: 'block', disposition: 'denied', checks: ['requirements'] }, event);
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Resolve the foundation with the user through $geppetto-spec. Use the Turn record reference to supply the complete ADR, then record it with ${recordCommand(event.session_id, state.turn)}.` } };
  }
  const strict = event.harness === 'codex';
  const override = strict && overrideFor(state, 'edit');
  const needsDecision = policy.checks.length && staged?.epoch !== state.epoch;
  const first = needsDecision && !override && await claimFile(`${path}.${state.epoch}.requested`, new Date().toISOString());
  if (needsDecision && !override && (first || strict && modifying)) {
    const needed = !staged || state.epoch === 'initial' || state.epoch === state.userEpoch ? policy.checks : policy.checks.filter(check => check.id === 'feedback');
    await logHookEvent(root, { hook: 'turnGate', status: 'block', disposition: modifying ? 'denied' : 'recovery', retry: !first, checks: needed.map(check => check.id) }, event);
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `${foundationReminder} Before editing, record ${needed.map(check => check.id).join(', ')} with ${recordCommand(event.session_id, state.turn)} from the project root. ${needed.map(({ id, question, skill }) => `${id}: ${question} Apply $${skill} if true; fields: ${decisionFields(id).join(', ')}.`).join(' ')} ${strict ? `To record an explicit override, run ${overrideCommand(event, state, 'edit')} with the real reason. ` : ''}Use the SessionStart schema or Turn record in "${fileURLToPath(new URL('../assets/templates/hooks/README.md', import.meta.url))}".` } };   }
  if (!modifying) return {};
  if (policy.checks.length) {
    const disposition = override ? 'override' : needsDecision ? 'unchecked' : 'decision';
    await logHookEvent(root, { hook: 'turnGate', status: 'allow', disposition }, event);
  }
  await claimFile(`${path}.edited`); return {};
}
const nativeReviewHome = () => process.env.CODEX_HOME || resolve(userHome(), '.codex');
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
async function verifiedReview(root, base, outcome, directory, session, codexHome) {
  const metrics = await jsonFile(resolve(directory, 'metrics.json'), null);
  const report = await jsonFile(resolve(directory, 'findings.json'), null);
  const fail = () => { throw new UsageError('Supply a completed independent review output that matches the current diff and outcome.'); };
  if (metrics?.status !== 'complete' || !Array.isArray(report?.findings) ||
      (outcome === 'findings') !== Boolean(report.findings.length)) fail();
  const { strategy, profile } = metrics;
  const required = strategy === 'questions' ? ['questions', 'investigate']
    : strategy === 'generic' ? ['search-1', 'search-2'] : [];
  if (strategy === 'lenses') {
    if (!['standard', 'ultra'].includes(profile)) fail();
    required.push('lens-adversarial', 'lens-contracts', 'lens-rules-tests');
    if (profile === 'ultra') required.push('gap-logic', 'gap-contracts-docs');
  }
  const { calls, thread_ids: threads, case_fingerprint: fingerprint, changed_paths: paths } = metrics;
  if (!required.length || !Array.isArray(calls) || !Array.isArray(threads) ||
      calls.length < required.length || calls.length > required.length + 1 || calls.length !== threads.length ||
      threads.includes(session) || new Set(threads).size !== threads.length ||
      !required.every((stage, index) => calls[index]?.stage === stage) ||
      (calls.length > required.length && calls[required.length]?.stage !== 'verify') ||
      new Set(calls.map(call => call.stage)).size !== calls.length || !Array.isArray(paths) || !fingerprint) fail();
  const responses = {};
  const seal = reviewMaterialSeal(fingerprint);
  for (const [index, call] of calls.entries()) {
    if (!/^(questions|investigate|search-[12]|lens-(?:adversarial|contracts|rules-tests)|gap-(?:logic|contracts-docs)|verify)$/.test(call.stage) || call.status !== 'completed' ||
        call.exit_code !== 0 || typeof threads[index] !== 'string' || !threads[index]) fail();
    const response = await readFile(resolve(directory, call.stage + '.json'), 'utf8');
    const expectedStage = strategy === 'lenses' ? call.stage : undefined;
    if (digest(response) !== call.response_sha256 ||
        !await completedReviewSession(codexHome, threads[index], call, response, seal, expectedStage)) fail();
    responses[call.stage] = JSON.parse(response);
    const events = (await readFile(resolve(directory, call.stage + '.events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    if (!events.some(event => event.type === 'thread.started' && event.thread_id === threads[index]) ||
        !events.some(event => event.type === 'turn.completed' && event.usage && Number(event.usage.output_tokens) > 0) ||
        events.some(event => ['turn.failed', 'error'].includes(event.type))) fail();
  }
  const findingsByStage = strategy === 'questions' ? [responses.investigate?.report?.findings]
    : required.map(stage => responses[stage]?.findings);
  if (!findingsByStage.every(Array.isArray)) fail();
  const candidates = findingsByStage.flat();
  if (calls.length !== required.length + Number(candidates.length > 0) ||
      Boolean(candidates.length) !== Boolean(responses.verify)) fail();
  const accepted = responses.verify?.accepted_findings ?? [];
  const byId = (left, right) => left.id.localeCompare(right.id, 'en');
  if (!Array.isArray(accepted) || !isDeepStrictEqual(accepted.toSorted(byId), report.findings.toSorted(byId))) fail();
  if (fingerprint['diff.patch'] !== await diffDigest(root, ['diff', '--binary', '--no-ext-diff', base, '--'], '')) fail();
  const changed = gitOutput(root, ['diff', '--name-only', '--no-renames', '-z', base, '--'], { trim: false }).split('\0').filter(Boolean);
  const untracked = gitOutput(root, ['ls-files', '--others', '--exclude-standard', '-z'], { trim: false })
    .split('\0').filter(path => path && !path.startsWith('.geppetto/'));
  if (![...changed, ...untracked].every(path => paths.includes(path))) fail();
  for (const path of paths) {
    if (typeof path !== 'string' || !contained(root, resolve(root, path))) fail();
    const file = resolve(root, path);
    await rejectSymlinks(file);
    const contents = await readFile(file).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const expected = fingerprint['after/' + path];
    const canonical = contents && changed.includes(path) && !contents.includes(0)
      ? digest(contents.toString('utf8').replaceAll('\r\n', '\n')) : undefined;
    if ((contents === null ? undefined : digest(contents)) !== expected &&
        (canonical === undefined || canonical !== expected)) fail();
  }
  return { kind: 'review-runner', sessions: threads };
}

export async function recordReview(root, base, outcome, { session, turn, evidence, codexHome = nativeReviewHome() } = {}) {
  if (!['passed', 'findings'].includes(outcome)) throw new UsageError('Review outcome must be passed or findings after independent review completes.');
  base = gitOutput(root, ['rev-parse', '--verify', `${base}^{commit}`]);
  if (!evidence) throw new UsageError('Review recording requires --evidence <review-output-directory>.');
  const state = session ? await readTurnState(root, session, turn) : null;
  if (session && (!state || (turn && state.turn !== turn))) throw new UsageError('Review recording needs a matching active session and turn.');
  const policy = await reviewPolicy(root);
  const current = await reviewSnapshot(root, base, policy);
  if (state && !state.reviewArchive) throw new UsageError('Start a fresh session so the hook can identify its native archive.');
  const verified = await verifiedReview(root, base, outcome, resolve(root, evidence), session, state?.reviewArchive ?? codexHome);
  if ((await reviewSnapshot(root, base, policy)).hash !== current.hash) throw new UsageError('The reviewed diff changed during recording.');
  await ignoreLocalFiles(root, ['/reviews.jsonl', '/hook-state/']);
  await atomicJson(resolve(root, '.geppetto/hook-state', `review-${base}-${current.hash}.json`), current.snapshot);
  const record = { hash: current.hash, base, ts: new Date().toISOString(), outcome, evidence: verified,
    provenance: state ? 'active-turn' : 'external' };
  const identity = state ? { harness: state.harness ?? null, sessionId: session, turnId: state.turn, epoch: state.epoch } : {};
  await appendRecord(root, 'reviews', { ...record, ...identity }); return record;
}
async function completionEvent(event, reviewArchive) {
  const kind = event.hook_event_name;
  if (process.env.GEPPETTO_LEARNING_CHILD === '1' || !event.session_id || !['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].includes(kind)) return {};
  const root = await projectRoot(event.cwd ?? '.'); if (!await exists(resolve(root, '.geppetto/config.json'))) return {}; const policy = await reviewPolicy(root);
  if (run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root }).status !== 0) return {};
  if (!Number.isSafeInteger(policy.threshold) || policy.threshold <= 0 || ![policy.docGlobs, policy.testGlobs].every(globs => Array.isArray(globs) && globs.every(glob => typeof glob === 'string'))) throw new UsageError('Invalid hooks.reviewGate threshold or globs.');
  return withTurnLock(`${turnStatePath(root, event.session_id)}.lock`, async () => {
  const statePath = turnStatePath(root, event.session_id); let state = currentState(await jsonFile(statePath, null)), fresh = false, resumedTurn = false, checkpoint, checkpointError;
  if (state && event.turn_id && state.turn !== event.turn_id) {
    await atomicJson(turnStatePath(root, event.session_id, state.turn), state);
    const resumed = currentState(await jsonFile(turnStatePath(root, event.session_id, event.turn_id), null));
    if (resumed) { state = resumed; resumedTurn = true; await atomicJson(statePath, state); }
  }
  if (kind === 'UserPromptSubmit' && !event.turn_id && state?.transcript_path) {
    try { checkpoint = await messageCheckpoint(event.transcript_path ? resolve(event.cwd ?? root, event.transcript_path) : state.transcript_path, state.promptCursor); }
    catch (error) { checkpointError = error; }
  }
  if (!state || (event.turn_id ? state.turn !== event.turn_id : kind === 'UserPromptSubmit' && (!checkpoint || checkpoint.userMessage))) {
    await ignoreLocalFiles(root, ['/turns.jsonl', '/reviews.jsonl', '/hook-state/', '/hook-events.jsonl']);
    const base = gitOutput(root, ['rev-parse', 'HEAD']);
    const prior = event.turn_id ? currentDecision(await jsonFile(decisionPath(root, event.session_id, event.turn_id), null)) : null;
    fresh = !prior;
    state = { harness: event.harness, requirementsSince: Date.now(), reviewArchive, transcript_path: event.transcript_path ? resolve(event.cwd ?? root, event.transcript_path) : state?.transcript_path, turn: event.turn_id ?? randomUUID(), previousTurnId: state?.turn ?? null, epoch: prior?.epoch ?? 'initial', userEpoch: prior?.userEpoch, userDecisionIndex: prior?.userDecisionIndex ?? 0, initialMessagePending: !prior, promptCursor: state?.promptCursor, base, worktree: await worktreeFingerprint(root), learningFiles: await learningFiles(root), ...(await reviewSnapshot(root, base, policy)) };
    await atomicJson(statePath, state);
  }
  const context = recordContext.getStore();
  if (context) Object.assign(context, { turnId: state.turn, epoch: state.epoch });
  if (!state.harness && event.harness) {
    state.harness = event.harness;
    await atomicJson(statePath, state);
  }
  if (event.transcript_path && state.transcript_path !== event.transcript_path) { state.transcript_path = resolve(event.cwd ?? root, event.transcript_path); await atomicJson(statePath, state); }
  const turnConfig = await jsonFile(resolve(root, '.geppetto/config.json'), {}); if (turnPolicy(turnConfig).checks.length || (state.transcript_path && turnConfig.hooks?.learnNudge?.enabled !== false)) {
    try { if (checkpointError) throw checkpointError; checkpoint ??= await messageCheckpoint(state.transcript_path, state.promptCursor); }
    catch (error) {
      if (!state.messageError) { state.messageError = error.code ?? 'invalid-transcript'; await atomicJson(statePath, state); await logHookEvent(root, { hook: 'turnGate', status: 'transcript-unavailable', reason: state.messageError, modelCalls: 0 }, event); }
    }
    if (checkpoint) {
      if (resumedTurn) await logHookEvent(root, { hook: 'turnGate', status: 'resumed', bytesRead: checkpoint.bytesRead, modelCalls: 0 }, event);
      if (checkpoint.userMessage && state.initialMessagePending) {
        state.initialMessagePending = false;
        const prior = currentDecision(await jsonFile(decisionPath(root, event.session_id, state.turn), null));
        if (!fresh && checkpoint.userMessages === 1 && !prior?.value?.continuation) checkpoint.userMessage = null;
      }
      if (!fresh && checkpoint.userMessage && state.userEpoch !== `user-${checkpoint.userMessage}`) {
        const prior = currentDecision(await jsonFile(decisionPath(root, event.session_id, state.turn), null));
        state.userEpoch = `user-${checkpoint.userMessage}`; state.requirementsSince = Date.now(); state.epoch = state.userEpoch; if (context) context.epoch = state.epoch;
        delete state.learningOutcome; delete state.learningRecorded; state.learningFiles = await learningFiles(root);
        state.userDecisionIndex = prior?.userEpoch === state.userEpoch ? prior.userDecisionIndex : prior?.decisions.length ?? 0;
        if (state.shellPending) state.shellPending = state.epoch;
        await logHookEvent(root, { hook: 'turnGate', status: 'user-message', bytesRead: checkpoint.bytesRead, modelCalls: 0 }, event);
      }
      if (JSON.stringify(checkpoint.cursor) !== JSON.stringify(state.promptCursor) || state.messageError) {
        state.promptCursor = checkpoint.cursor; delete state.messageError; await atomicJson(statePath, state);
      }
    }
  }
  if (kind === 'UserPromptSubmit') return {};
  if (kind === 'Stop') { const staged = currentDecision(await jsonFile(decisionPath(root, event.session_id, state.turn), null)); const learning = await learningGate(root, state, statePath, event, staged); if (learning.decision) return learning; }
  if (['PreToolUse', 'PostToolUse'].includes(kind)) return editingEvent(root, state, statePath, event, turnPolicy(turnConfig));
  if (policy.enabled === false) return {};
  if (kind !== 'Stop') return {};
  const records = []; for (const record of await localRecords(root, 'reviews', { currentWorktree: true })) if (record.provenance === 'active-turn' && record.evidence?.kind === 'review-runner' && await exists(resolve(root, '.geppetto/hook-state', `review-${record.base}-${record.hash}.json`))) records.push(record);
  const last = records.at(-1); const current = await reviewSnapshot(root, last?.base ?? state.base, policy); const lines = await changedLines(root, state.snapshot, current.snapshot); const reviewed = last && await jsonFile(resolve(root, '.geppetto/hook-state', `review-${last.base}-${last.hash}.json`), null); const sinceReview = reviewed === null || reviewed === undefined ? lines : await changedLines(root, reviewed, current.snapshot);
  let status = 'below-threshold';
  if (records.some(record => record.base === last.base && record.hash === current.hash)) status = 'reviewed';
  else if (policy.enabled && lines >= policy.threshold && sinceReview >= policy.threshold) status = 'block';
  if (status === 'block') for (const record of records.slice(0, -1).reverse()) {
    if (await jsonFile(resolve(root, '.geppetto/hook-state', `review-${record.base}-${record.hash}.json`), null) === current.snapshot && (await reviewSnapshot(root, record.base, policy)).hash === record.hash) { status = 'reviewed'; break; }
  }
  if (event.harness !== 'codex' && status === 'block' && /(?:Independent review blocked|Revisione indipendente bloccata):\s*\S.+/i.test(event.last_assistant_message ?? '')) status = 'blocker';
  const staged = currentDecision(await jsonFile(decisionPath(root, event.session_id, state.turn), null)); const reasons = status === 'block' ? [`Code changed without an independent review: run $geppetto-verify. Record the completed review runner output before fixing findings: node "${fileURLToPath(import.meta.url).replaceAll('\\', '/')}" --record-review --base ${state.base} --outcome <passed|findings> --evidence <review-output-directory> --session ${JSON.stringify(event.session_id)} --turn ${JSON.stringify(state.turn)}. Fixes below the configured threshold reuse that review.${event.harness !== 'codex' ? ' State the concrete blocker if review is unavailable.' : ''}`] : [];
  const strict = event.harness === 'codex';
  if (strict && status === 'block' && overrideFor(state, 'stop')) { status = 'override'; reasons.length = 0; }
  let block = reasons.length > 0 && (strict || !event.stop_hook_active); const blockPath = `${statePath}.${digest(state.turn + ':' + state.epoch)}.blocked`;
  const retry = event.stop_hook_active === true || await exists(blockPath);
  const first = block && await claimFile(blockPath, status);
  if (block && !strict) block = first;
  if (status === 'block' && !block) status = 'second-stop';
  await logHookEvent(root, { hook: 'reviewGate', status, disposition: block ? (first ? 'denied' : 'retry-denied') : status === 'second-stop' ? 'unresolved' : status, retry, lines, sinceReview, hash: current.hash }, event);
  if (staged && !block) {
    const marker = `${decisionPath(root, event.session_id, state.turn)}.recorded`; if (await claimFile(marker)) try {
      const transcriptPath = state.transcript_path ?? null, transcriptOffset = transcriptPath ? (await lstat(transcriptPath)).size : null; const decisions = staged.decisions, first = decisions[0]; const edited = await lstat(`${decisionPath(root, event.session_id, state.turn)}.edited`).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
      await appendRecord(root, 'turns', { ...staged.value, requestedAt: first.requestedAt, decidedAt: first.decidedAt, decisions, userDecisionIndex: staged.userDecisionIndex ?? 0, edited, addedSeconds: decisions.reduce((sum, d) => sum + Math.max(0, Date.parse(d.decidedAt) - Date.parse(d.requestedAt)) / 1000, 0), review: { status, lines, sinceReview, hash: current.hash }, sessionId: event.session_id, turnId: state.turn, previousTurnId: state.previousTurnId, ts: new Date().toISOString(), transcriptPath, transcriptOffset });
      await logHookEvent(root, { hook: 'turnGate', status: 'recorded' }, event);
    } catch (error) { await unlink(marker); throw error; }
  }
  let review_blocked = false; try { review_blocked = !['reviewed', 'below-threshold'].includes(status) && (await readFile(blockPath, 'utf8')) === 'block'; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...(block ? { decision: 'block', reason: [...reasons, ...(strict ? [`For an explicit override, run ${overrideCommand(event, state, 'stop')} with the real reason.`] : [])].join('\n') } : {}), review_blocked }; }); }
async function dispatch(event, { runCommand = run, now = Date.now, home, codexHome = nativeReviewHome() } = {}) {
  if (!event || typeof event !== 'object') throw new UsageError('Hook input must be an event object');
  const learningChild = process.env.GEPPETTO_LEARNING_CHILD === '1';
  if (event.hook_event_name === 'SessionStart') {
    if (learningChild) return {};
    if (event.session_id) await captureResources(event, { home, runCommand });
    return sessionStart(event, { home, now });
  }
  const { review_blocked, ...review } = await completionEvent(event, resolve(codexHome));
  if (!learningChild) {
    await logReads(event, { home });
    if (event.hook_event_name === 'Stop' && event.session_id && !event.stop_hook_active) await captureResources(event, { home, runCommand });
  }
  if (review.hookSpecificOutput?.permissionDecision === 'deny') return review;
  const learning = review.decision === 'block' ? {} : await learningEvent({ ...event, review_blocked }, now, { runCommand }); const native = await nativeMemoryEvent(event, { home }); if (event.hook_event_name === 'UserPromptSubmit') return {};
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
  if (isAntigravityEvent(event, options?.harness)) {
    const normalized = normalizeAntigravityEvent(event);
    const context = { harness: 'antigravity', sessionId: normalized?.session_id ?? null, turnId: null, epoch: null, ...(normalized?.hook_event_name === 'Stop' && { stopAttemptId: randomUUID() }) };
    return recordContext.run(context, () => handleAntigravityEvent(normalized, { ...options, harness: 'antigravity' }, handleWithEvidence));
  }
  const harness = options?.harness ?? (event?.turn_id || process.env.PLUGIN_ROOT ? 'codex'
    : process.env.CLAUDE_PLUGIN_ROOT || (event?.session_id && event.hook_event_name !== 'SessionStart') ? 'claude' : null);
  const context = { harness, sessionId: event?.session_id ?? null, turnId: event?.turn_id ?? null, epoch: null, ...(event?.hook_event_name === 'Stop' && { stopAttemptId: randomUUID() }) };
  return recordContext.run(context, () => handleWithEvidence(event && { ...event, harness }, options));
}

async function handleWithEvidence(event, options) {
  try { return await dispatch(event, options); }
  catch (error) {
    const phase = event?.hook_event_name;
    if (!['PreToolUse', 'PostToolUse', 'Stop'].includes(phase)) throw error;
    const diagnostic = error => redact(error.message).replace(/[\r\n]+/g, ' ').slice(0, 500);
    let journalError;
    try {
      const root = await projectRoot(event.cwd ?? '.');
      const statePath = turnStatePath(root, event.session_id ?? 'unknown');
      // Recovery must tolerate the state corruption that brought the hook here.
      const state = await jsonFile(statePath, null).catch(() => null);
      const context = recordContext.getStore();
      if (context && state && (!event.turn_id || event.turn_id === state.turn)) {
        context.turnId ??= state.turn;
        context.epoch ??= state.epoch;
      }
      await ignoreLocalFiles(root, ['/hook-state/']);
      await mkdir(dirname(statePath), { recursive: true });
      const marker = statePath + '.' + digest(JSON.stringify([context?.turnId, context?.epoch, phase])) + '.error';
      if (await claimFile(marker)) try {
        await logHookEvent(root, { hook: 'completion', phase, status: 'error', eligibleEdit: phase === 'PreToolUse' && modifyingTool(event), error: diagnostic(error) }, event);
      } catch (cause) { await unlink(marker); throw cause; }
    } catch (cause) {
      journalError = cause;
    }
    if (phase !== 'Stop' || journalError) {
      const fallback = journalError ? ' Journal error: ' + diagnostic(journalError) : '';
      console.error('Geppetto ' + phase + ' diagnostic: ' + diagnostic(error) + fallback);
    }
    return {};
  }
}
export const main = async args => {
  const nativeHarness = args.length === 2 && args[0] === '--harness' && ['codex', 'claude', 'antigravity'].includes(args[1]) ? args[1] : undefined;
  if (!args.length || nativeHarness) {
    let rawEvent;
    try {
      return await hookMain([], 'Hook', event => { rawEvent = event; return handleEvent(event, { harness: nativeHarness }); });
    } catch (error) {
      console.error(`Geppetto hook diagnostic: ${redact(error.message).replace(/[\r\n]+/g, ' ')}`);
      const failOpen = (nativeHarness === 'antigravity' || rawEvent?.hookEventName) && (rawEvent?.hookEventName ?? rawEvent?.hook_event_name) === 'PreToolUse' ? { decision: 'allow' } : {};
      console.log(JSON.stringify(failOpen));
      return 0;
    }
  }
  const opts = parseArgs(args, { flags: ['--current-turn', '--record-review'], values: ['--base', '--outcome', '--record-turn', '--session', '--turn', '--evidence'] });
  if (opts['--current-turn'] && opts['--session'] && Object.keys(opts).every(key => ['_', '--current-turn', '--session'].includes(key)) && !opts._.length) {
    const state = currentState(await readTurnState(await projectRoot('.'), opts['--session']));
    if (!state) throw new UsageError('No matching active session for the requirements screen.');
    console.log(JSON.stringify({ session: opts['--session'], turn: state.turn }));
    return 0;
  }
  if (opts['--record-turn'] && opts['--session'] && opts._.length === 0 && Object.keys(opts).every(key => ['_', '--record-turn', '--session', '--turn'].includes(key))) {
    let value; try { value = JSON.parse(opts['--record-turn'] === '-' ? readFileSync(0, 'utf8') : opts['--record-turn']); } catch { throw new UsageError('Turn decision must be JSON.'); }
    console.log(JSON.stringify(await recordTurn(await projectRoot('.'), opts['--session'], opts['--turn'], value))); return 0;
  }
  if (!opts['--record-review'] || !opts['--base'] || !opts['--outcome'] || opts._.length) throw new UsageError('Usage: hook.mjs --record-review --base <ref> --outcome <passed|findings> --evidence <review-output-directory>');
  console.log(JSON.stringify(await recordReview(await projectRoot('.'), opts['--base'], opts['--outcome'], { session: opts['--session'], turn: opts['--turn'], evidence: opts['--evidence'] }))); return 0;
};
if (isMain(import.meta.url)) await cli(main);
