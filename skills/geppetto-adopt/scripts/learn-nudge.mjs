import { appendFile, mkdir, readFile, unlink, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { exists, jsonFile, ignoreLocalFiles, learnNudgeDefaults, projectRoot, claimFile, launchLearning } from './common.mjs';
import { logHookEvent } from './hook-events.mjs';
import { createReadStream } from 'node:fs';
import { redact, eligibleSignals, signalArchive, learningPolicy, localRecords } from './signal.mjs';
export { launchLearning } from './common.mjs';
/** Record tool starts; completion adds learning context once per qualifying turn. */
export async function learningEvent(event, now, launch = launchLearning) {
  if (process.env.GEPPETTO_LEARNING_CHILD === '1') return {};
  const kind = event.hook_event_name ?? 'PreToolUse';
  if (!['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].includes(kind) || typeof event.session_id !== 'string' || !event.session_id || event.stop_hook_active && kind !== 'Stop') return {};
  const root = await projectRoot(event.cwd ?? '.'); const configPath = resolve(root, '.geppetto/config.json');
  if (!await exists(configPath) && !(kind === 'Stop' && (await localRecords(root, 'signals')).length > 0)) return {};
  const config = { ...learnNudgeDefaults, ...(await jsonFile(configPath, {})).hooks?.learnNudge };
  if (!config.enabled && !(kind === 'Stop' && (await localRecords(root, 'signals')).length > 0)) return {};
  for (const key of ['minToolCalls', 'minDurationMs']) if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`${configPath}:1: hooks.learnNudge.${key} must be a positive integer`);
  const session = createHash('sha256').update(event.session_id).digest('hex'); const state = resolve(root, '.geppetto/hook-state', session); const activity = resolve(state, 'activity.jsonl');
  if (!['PostToolUse', 'Stop'].includes(kind)) {
    await mkdir(state, { recursive: true });
    await ignoreLocalFiles(root, ['/hook-state/', '/hook-events.jsonl']);
    await appendFile(activity, `${JSON.stringify({ kind, at: now(), id: event.tool_use_id ?? randomUUID(), turn: event.turn_id ?? null })}\n`, { mode: 0o600 });
    return {};   }
  const records = await exists(activity) ? (await readFile(activity, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) : []; const lastPrompt = records.findLastIndex(record => record.kind === 'UserPromptSubmit'); const calls = records.slice(lastPrompt + 1).filter(record => record.kind === 'PreToolUse' && (!event.turn_id || record.turn === event.turn_id)); const unique = [...new Map(calls.map(call => [call.id, call])).values()];
  const elapsedMs = unique.length ? now() - Math.min(...unique.map(call => call.at)) : 0; const qualified = config.enabled && (unique.length >= config.minToolCalls || elapsedMs >= config.minDurationMs); const signals = kind === 'Stop' && (await eligibleSignals(root)).length > 0;
  if (!qualified && !signals) return {};
  const turn = event.turn_id || unique[0]?.turn || records[lastPrompt]?.id || unique[0]?.id || 'signals'; const turnHash = createHash('sha256').update(turn).digest('hex'); const fired = resolve(state, `fired-${turnHash}`);
  if (kind === 'Stop' && (event.transcript_path || signals || launch !== launchLearning) && (await jsonFile(configPath, {})).hooks?.signalLearning?.enabled !== false) {
    await mkdir(state, { recursive: true }); await ignoreLocalFiles(root, ['/hook-state/']);
    const started = resolve(state, `started-${turnHash}`);
    if (!await claimFile(started)) return {};
    try { await launch({ ...event, learning_qualified: qualified }); }
    catch (error) { await unlink(started); throw error; }
  }
  if (!qualified) return {};
  if (!await claimFile(fired)) return {};
  const entry = { hook: 'learnNudge', event: kind, session, turn, ts: new Date(now()).toISOString(), toolCalls: unique.length, elapsedMs, modelCalls: 0, costUsd: 0 };
  try { await logHookEvent(root, entry, event); }
  catch (error) { await unlink(fired); throw error; }
  const keys = (await signalArchive(root)).filter(row => row.status === 'open' && !row.legacy).map(row => row.key), categories = learningPolicy(await jsonFile(configPath, {})).categories;
  return { hookSpecificOutput: { hookEventName: kind, additionalContext: `Use $geppetto-learn for reusable lessons. Open keys: ${JSON.stringify(keys)}. Reuse one or open a short slug; record once per session with node "${fileURLToPath(new URL('./signal.mjs', import.meta.url)).replaceAll('\\', '/')}" "<lesson>" --key <key> --session ${JSON.stringify(event.session_id)} --category <id>. Assign one primary category per episode in configured order: ${categories.map(row => row.id).join(' > ')}; secondary effects go in --attributes <json-object>. other requires --evidence. User feedback/frustration provenance comes from the turn record. Keep this check internal and continue the task.` } }; }
const sliceBytes = 40 * 1024;
const errorOutput = value => /(?:"(?:is_error|isError)"\s*:\s*true|"(?:exit_code|exitCode)"\s*:\s*-?[1-9]\d*|Process exited with code -?[1-9]\d*|(?:^|\n)(?:Exit code:?\s*-?[1-9]\d*|Error:|ERROR\b|Traceback\b))/.test(value);
/** Reduce complete JSONL records from a byte cursor; partial final records remain pending. */
export async function transcriptSlice(path, start = 0, reviewBlocked = false, turns = []) {
  if (start > (await stat(path)).size) start = 0;
  const parts = []; let pending = Buffer.alloc(0), offset = 0, candidate = reviewBlocked; const decisions = turns.filter(turn => Number.isSafeInteger(turn.transcriptOffset)).sort((a, b) => a.transcriptOffset - b.transcriptOffset);
  let preceding = decisions.findLast(turn => turn.transcriptOffset <= start);
  const recent = decisions.filter(turn => turn.transcriptOffset > start), evidence = new Set();
  const add = (role, text, limit) => {
    if (!text) return;
    parts.push({ role, text: `${role}: ${redact(text).slice(0, limit)}\n` });
  };
  for await (const chunk of createReadStream(path)) {
    pending = Buffer.concat([pending, chunk]); let end;
    while ((end = pending.indexOf(10)) !== -1) {
      const lineStart = offset, line = pending.subarray(0, end).toString('utf8'); pending = pending.subarray(end + 1); offset += end + 1;
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (lineStart < start) continue;
      while (recent[0]?.transcriptOffset <= lineStart) preceding = recent.shift();
      const message = record.type === 'response_item' ? record.payload : record.message;
      if (!message) continue;
      const role = message.role ?? record.type;
      if (['function_call', 'custom_tool_call'].includes(message.type)) { add('tool', `${message.name} ${String(message.arguments ?? message.input ?? '')}`, 300); continue; }
      if (['function_call_output', 'custom_tool_call_output'].includes(message.type)) { const output = typeof message.output === 'string' ? message.output : JSON.stringify(message.output); if (errorOutput(output ?? '')) { candidate = true; add('error', output, 500); } continue; }
      if (!['user', 'assistant'].includes(role)) continue;
      const before = parts.length;
      if (typeof message.content === 'string') add(role, message.content);
      else for (const block of message.content ?? []) {
        if (['text', 'input_text', 'output_text'].includes(block.type)) add(role, block.text);
        if (block.type === 'tool_use') add('tool', `${block.name} ${JSON.stringify(block.input ?? {})}`, 300);
        if (block.type === 'tool_result') { const output = typeof block.content === 'string' ? block.content : JSON.stringify(block.content); if (block.is_error || errorOutput(output ?? '')) { candidate = true; add('error', output, 500); } }
      }
      if (parts.slice(before).some(part => part.role === 'user') && preceding) {
        evidence.add(preceding);
        candidate ||= preceding.requirements?.changes === false || preceding.frustration?.applies === false;
      }
    }
  }
  candidate ||= parts.some(part => part.role === 'user' && /\b(?:no|wrong|instead|actually|correction|incorrect|fix|sbagliato|invece|correggi|correzione|errore)\b/i.test(part.text));
  let text = parts.map(part => part.text).join('');
  if (Buffer.byteLength(text) > sliceBytes) {
    const users = parts.filter(part => part.role === 'user').map(part => part.text).join('');
    if (Buffer.byteLength(users) > sliceBytes) throw new Error('User messages exceed the learning slice budget; transcript cursor retained.');
    const otherBytes = parts.filter(part => part.role !== 'user').reduce((size, part) => size + Buffer.byteLength(part.text), 0); const half = Math.floor((sliceBytes - Buffer.byteLength(users)) / 2);
    // Decode through TextDecoder so clipped UTF-8 never expands beyond the byte budget.
    const decode = bytes => new TextDecoder('utf-8', { fatal: false }).decode(bytes).replaceAll('\uFFFD', '');
    let position = 0;
    text = parts.map(part => {
      if (part.role === 'user') return part.text;
      const bytes = Buffer.from(part.text), head = Math.min(bytes.length, Math.max(0, half - position)), tail = Math.min(bytes.length, Math.max(head, otherBytes - half - position)); position += bytes.length;
      return decode(bytes.subarray(0, head)) + decode(bytes.subarray(tail));
    }).join('');
  }
  return { text, offset, candidate, turns: [...new Set([...evidence, ...decisions.filter(turn => turn.transcriptOffset > start && turn.transcriptOffset <= offset)])] }; }
