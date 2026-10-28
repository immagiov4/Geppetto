import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ignoreLocalFiles } from './common.mjs';

export async function logHookEvent(project, event, context = {}) {
  const identity = Object.fromEntries([['sessionId', context.session_id], ['turnId', context.turn_id]]
    .filter(([, value]) => typeof value === 'string' && value.trim()));
  await ignoreLocalFiles(project, ['/hook-events.jsonl']);
  await appendFile(resolve(project, '.geppetto/hook-events.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), ...event, ...identity })}\n`, { mode: 0o600 });
}
