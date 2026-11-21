import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const dayMs = 86_400_000;
const codexSessionId = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

export function reviewMaterialSeal(fingerprint) {
  const entries = Object.entries(fingerprint).sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

/** Match an exported result to Codex's own append-only archive, without retaining its contents. */
export async function completedReviewSession(home, thread, call, response, materialSeal) {
  if (!codexSessionId.test(thread) || !Number.isFinite(call.started_at)) return false;
  const start = call.started_at * 1000;
  const date = instant => new Date(instant).toISOString().slice(0, 10).replaceAll('-', '/');
  for (const day of new Set([date(start), date(start - dayMs), date(start + dayMs)])) {
    const folder = resolve(home, 'sessions', day);
    const sessions = await readdir(folder).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const archive = sessions.find(path => path.startsWith('rollout-') && path.endsWith(thread + '.jsonl'));
    if (!archive) continue;
    const records = (await readFile(resolve(folder, archive), 'utf8')).split('\n').filter(line => line.trim()).map(JSON.parse);
    const identified = records.some(record => record.type === 'session_meta' && record.payload?.id === thread);
    const bound = records.some(record => record.type === 'response_item' && record.payload?.role === 'user' &&
      record.payload.content?.some(part => part.type === 'input_text' &&
        part.text?.split('\n').includes('Review material SHA-256: ' + materialSeal)));
    if (!identified || !bound) return false;
    return records.some(record => {
      const event = record.type === 'event_msg' && record.payload;
      if (event?.type !== 'task_complete' || typeof event.last_agent_message !== 'string') return false;
      try { return isDeepStrictEqual(JSON.parse(event.last_agent_message), JSON.parse(response)); }
      catch { return false; }
    });
  }
  return false;
}
