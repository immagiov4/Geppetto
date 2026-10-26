import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const settings = JSON.parse(readFileSync(new URL('./settings.json', import.meta.url), 'utf8'));
const input = JSON.parse(readFileSync(0, 'utf8'));
const root = input.projectRoot ?? settings.projectRoot;
const { learningEvent } = await import(pathToFileURL(resolve(settings.scripts, 'learn-nudge.mjs')));
const event = { session_id: input.session_id, turn_id: input.turn_id, cwd: root };
let learning = {};
let memory = {};
if (input.phase === 'begin') {
  // Recover an unfired reminder from a previous turn before resetting its counters.
  learning = await learningEvent({ ...event, turn_id: undefined, hook_event_name: 'PostToolUse' }, Date.now);
  await learningEvent({ ...event, hook_event_name: 'UserPromptSubmit' }, Date.now);
  const { handleMemoryEvent } = await import(pathToFileURL(resolve(settings.scripts, 'memory-hook.mjs')));
  // SessionStart is read-only index retrieval. Never invoke the optional classifier.
  memory = await handleMemoryEvent({ ...event, hook_event_name: 'SessionStart' });
} else if (input.phase === 'tool') {
  const now = Date.now();
  const duration = Number.isFinite(input.duration_ms) ? Math.max(0, input.duration_ms) : 0;
  await learningEvent({ ...event, hook_event_name: 'PreToolUse', tool_use_id: input.tool_call_id }, () => now - duration);
  if (input.can_remind) learning = await learningEvent({ ...event, hook_event_name: 'PostToolUse' }, () => now);
} else {
  throw new Error('Unsupported bridge phase');
}
console.log(JSON.stringify({ memory: memory.hookSpecificOutput?.additionalContext ?? '', learning: learning.hookSpecificOutput?.additionalContext ?? '' }));
