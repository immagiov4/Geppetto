import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ignoreLocalFiles } from './common.mjs';

export async function logHookEvent(project, event) {
  await ignoreLocalFiles(project, ['/hook-events.jsonl']);
  await appendFile(resolve(project, '.geppetto/hook-events.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
}
