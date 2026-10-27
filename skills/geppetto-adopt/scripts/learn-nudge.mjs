import { appendFile, mkdir, readFile, open, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { exists, jsonFile, ignoreLocalFiles, learnNudgeDefaults } from './common.mjs';

async function projectRoot(cwd) {
  for (let root = resolve(cwd); ; root = dirname(root)) {
    if (await exists(resolve(root, '.geppetto/config.json'))) return root;
    if (dirname(root) === root) return null;
  }
}

/** Record tool starts; completion adds learning context once per qualifying turn. */
export async function learningEvent(event, now) {
  if (process.env.GEPPETTO_LEARNING_CHILD === '1') return {};
  const kind = event.hook_event_name ?? 'PreToolUse';
  if (!['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].includes(kind) || typeof event.session_id !== 'string' || !event.session_id || event.stop_hook_active) return {};
  const root = await projectRoot(event.cwd ?? '.');
  if (!root) return {};
  const configPath = resolve(root, '.geppetto/config.json');
  const config = { ...learnNudgeDefaults, ...(await jsonFile(configPath)).hooks?.learnNudge };
  if (!config.enabled) return {};
  for (const key of ['minToolCalls', 'minDurationMs']) if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`${configPath}:1: hooks.learnNudge.${key} must be a positive integer`);
  const session = createHash('sha256').update(event.session_id).digest('hex');
  const state = resolve(root, '.geppetto/hook-state', session);
  const activity = resolve(state, 'activity.jsonl');
  if (!['PostToolUse', 'Stop'].includes(kind)) {
    await mkdir(state, { recursive: true });
    await ignoreLocalFiles(root, ['/hook-state/', '/hook-events.jsonl']);
    await appendFile(activity, `${JSON.stringify({ kind, at: now(), id: event.tool_use_id ?? randomUUID(), turn: event.turn_id ?? null })}\n`, { mode: 0o600 });
    return {};
  }
  if (!await exists(activity)) return {};
  const records = (await readFile(activity, 'utf8')).trim().split('\n').map(JSON.parse);
  const lastPrompt = records.findLastIndex(record => record.kind === 'UserPromptSubmit');
  const calls = records.slice(lastPrompt + 1).filter(record => record.kind === 'PreToolUse' && (!event.turn_id || record.turn === event.turn_id));
  const unique = [...new Map(calls.map(call => [call.id, call])).values()];
  if (!unique.length) return {};
  const elapsedMs = now() - Math.min(...unique.map(call => call.at));
  if (unique.length < config.minToolCalls && elapsedMs < config.minDurationMs) return {};
  const turn = event.turn_id || unique[0].turn || records[lastPrompt]?.id || unique[0].id;
  const turnHash = createHash('sha256').update(turn).digest('hex');
  const fired = resolve(state, `fired-${turnHash}`);
  let marker;
  try { marker = await open(fired, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') return {}; throw error; }
  await marker.close();
  const entry = { hook: 'learnNudge', event: kind, session, turn, ts: new Date(now()).toISOString(), toolCalls: unique.length, elapsedMs, modelCalls: 0, costUsd: 0 };
  try { await appendFile(resolve(root, '.geppetto/hook-events.jsonl'), `${JSON.stringify(entry)}\n`, { mode: 0o600 }); }
  catch (error) { await unlink(fired); throw error; }
  return { hookSpecificOutput: { hookEventName: kind, additionalContext: 'Before your final reply, use $geppetto-learn to improve the existing owner when this turn produced a reusable workflow, a verified fix after a dead end, a user correction or recurring friction; if so, record one concise signal with node .geppetto/bin/signal.mjs "<lesson>" --metric <affected-metric> from the project root; a reusable lesson or decision rationale with no other owner goes to bucket memory through $geppetto-memory. Keep this routine check internal and continue the requested task. ' } };
}
