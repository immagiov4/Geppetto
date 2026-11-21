import { metricLimits, metricReminder, prTimingNote } from './metric-anomalies.mjs';
import { metricOperation, finishMetric, metricDiagnostic } from './metrics.mjs';
import { readTurnState, withTurnLock, turnStatePath, decisionPath, currentDecision } from './turn-messages.mjs';
import { appendFile, mkdir, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { exists, jsonFile, ignoreLocalFiles, learnNudgeDefaults, projectRoot, claimFile } from './common.mjs';
import { logHookEvent } from './hook-events.mjs';
import { eligibleSignals, learningPolicy, localRecords } from './signal.mjs';
export async function learningEvent(event, now, { runCommand } = {}) {
  if (process.env.GEPPETTO_LEARNING_CHILD === '1') return {};
  const kind = event.hook_event_name ?? 'PreToolUse';
  // Stop cannot carry additional context in Codex or Claude Code; offers reach the session at PostToolUse.
  if (!['UserPromptSubmit', 'PreToolUse', 'PostToolUse'].includes(kind) || typeof event.session_id !== 'string' || !event.session_id) return {};
  const root = await projectRoot(event.cwd ?? '.'); const configPath = resolve(root, '.geppetto/config.json');
  if (!await exists(configPath) && !(kind === 'PostToolUse' && (await localRecords(root, 'signals')).length > 0)) return {};
  const projectConfig = await jsonFile(configPath, {});
  const config = { ...learnNudgeDefaults, ...projectConfig.hooks?.learnNudge };
  const learn = config.enabled || kind === 'PostToolUse' && (await localRecords(root, 'signals')).length > 0;
  const measured = typeof event.tool_use_id === 'string' && event.tool_use_id;
  let operation;
  if (measured && kind === 'PreToolUse') {
    try { operation = metricOperation(event, projectConfig.metrics); }
    catch (error) { await metricDiagnostic(root, event, error); }
  }
  if (!learn && !operation && !(measured && kind === 'PostToolUse')) return {};
  for (const key of ['minToolCalls', 'minDurationMs']) if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`${configPath}:1: hooks.learnNudge.${key} must be a positive integer`);
  const session = createHash('sha256').update(event.session_id).digest('hex'); const state = resolve(root, '.geppetto/hook-state', session); const activity = resolve(state, 'activity.jsonl');
  const snapshot = turnStatePath(root, event.session_id), hasState = await exists(snapshot) || event.turn_id && await exists(turnStatePath(root, event.session_id, event.turn_id));
  const { active, decision } = hasState ? await withTurnLock(`${snapshot}.lock`, async () => {
    const active = await readTurnState(root, event.session_id, event.turn_id) ?? {}; const decision = kind === 'PostToolUse' && active.turn ? currentDecision(await jsonFile(decisionPath(root, event.session_id, active.turn), null)) : null;
    return { active, decision }; }) : { active: {}, decision: null };
  const messageTurn = active.userEpoch && (!event.turn_id || active.turn === event.turn_id) ? `${active.turn}:${active.userEpoch}` : event.turn_id || active.turn;
  if (kind !== 'PostToolUse') {
    try {
      if (operation) {
        const limits = await metricLimits(root, { sessionId: event.session_id, turnId: event.turn_id ?? active.turn, key: operation.key }, projectConfig.metrics);
        if (limits.expectedMs || limits.warnMs) operation.limits = limits;
      }
      await mkdir(state, { recursive: true });
      await ignoreLocalFiles(root, ['/hook-state/', '/hook-events.jsonl']);
      await appendFile(activity, `${JSON.stringify({ kind, at: now(), id: event.tool_use_id ?? randomUUID(), turn: messageTurn ?? null, operation })}\n`, { mode: 0o600 });
    } catch (error) {
      if (!operation) throw error;
      await metricDiagnostic(root, event, error);
    }
    return {};
  }
  let records, reminder;
  const metricOnly = () => reminder ? { hookSpecificOutput: { hookEventName: kind, additionalContext: reminder } } : {};
  try {
    records = await exists(activity) ? (await readFile(activity, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    if (measured) {
      const row = await finishMetric(root, state, { ...event, turn_id: event.turn_id ?? active.turn }, records, now());
      if (row) {
        reminder = await metricReminder(root, row);
        const prNote = await prTimingNote(root, event, row, runCommand);
        reminder = [reminder, prNote].filter(Boolean).join('\n');
      }
    }
  } catch (error) {
    if (!measured) throw error;
    await metricDiagnostic(root, event, error);
  }
  if (!learn || !records) return metricOnly();
  const lastPrompt = records.findLastIndex(record => record.kind === 'UserPromptSubmit' && (!messageTurn || record.turn === messageTurn)); const calls = records.slice(lastPrompt + 1).filter(record => record.kind === 'PreToolUse' && (!messageTurn || record.turn === messageTurn)); const unique = [...new Map(calls.map(call => [call.id, call])).values()];
  const elapsedMs = unique.length ? now() - Math.min(...unique.map(call => call.at)) : 0; const qualified = config.enabled && (unique.length >= config.minToolCalls || elapsedMs >= config.minDurationMs); const signals = projectConfig.hooks?.signalLearning?.enabled !== false && (await eligibleSignals(root)).length > 0;
  const assessed = kind === 'PostToolUse' && config.enabled && !active.messageError && decision?.epoch === active.epoch && decision?.userEpoch === active.userEpoch && (decision?.userDecisionIndex ?? 0) === (active.userDecisionIndex ?? 0) && (decision?.value.feedback?.applies === true || decision?.value.frustration?.applies === true);
  if (!qualified && !signals && !assessed) return metricOnly(); const turn = messageTurn || unique[0]?.turn || records[lastPrompt]?.id || unique[0]?.id || 'signals'; const keys = (await eligibleSignals(root)).map(row => row.key); const turnHash = createHash('sha256').update(turn + JSON.stringify(keys)).digest('hex'); const fired = resolve(state, `fired-${turnHash}`);
  await mkdir(state, { recursive: true }); await ignoreLocalFiles(root, ['/hook-state/']);
  if (!await claimFile(fired)) return metricOnly();
  const entry = { hook: 'learnNudge', event: kind, session, turn, ts: new Date(now()).toISOString(), toolCalls: unique.length, elapsedMs, modelCalls: 0, costUsd: 0 };
  try { await logHookEvent(root, entry, event); }
  catch (error) { await unlink(fired); throw error; }
  const categories = learningPolicy(projectConfig).categories;
  return { hookSpecificOutput: { hookEventName: kind, additionalContext: `${reminder ? reminder + '\n' : ''}Use $geppetto-learn in this working turn. Close eligible signals with hook.mjs --record-turn and a learning outcome (lesson with changed project owner path, covered with existing rule path, one-off with reason, blocked with owner/reason and key). Include key to close the offered signal. Open keys: ${JSON.stringify(keys)}. Reuse one or open a short slug; record once per session with node "${fileURLToPath(new URL('./signal.mjs', import.meta.url)).replaceAll('\\', '/')}" "<lesson>" --key <key> --session ${JSON.stringify(event.session_id)}${event.turn_id || active.turn ? ` --turn ${JSON.stringify(event.turn_id || active.turn)}` : ''} --category <id>. Assign one primary category per episode in configured order: ${categories.map(row => row.id).join(' > ')}; secondary effects go in --attributes <json-object>. other requires --evidence. User feedback/frustration provenance comes from the turn record. Keep this check internal and continue the task.` } }; }
