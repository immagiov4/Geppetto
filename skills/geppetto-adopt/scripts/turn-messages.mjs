import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { jsonFile, userHome } from './common.mjs';
import { withLocalLock } from './local-lock.mjs';
import { recordLockRecovery } from './health.mjs';
import { randomUUID, createHash } from 'node:crypto';


const digest = text => createHash('sha256').update(text).digest('hex'); export const decisionPath = (root, session, turn) => resolve(root, '.geppetto/hook-state', `decision-${digest(session)}-${digest(turn)}.json`);
export const currentDecision = decision => decision && typeof decision.epoch === 'string' && decision.value && Array.isArray(decision.decisions) && decision.decisions.length ? decision : null; export const turnStatePath = (root, session, turn) => resolve(root, '.geppetto/hook-state', `review-turn-${digest(session)}${turn ? '-' + digest(turn) : ''}.json`);
export async function readTurnState(root, session, turn) {
  const active = await jsonFile(turnStatePath(root, session), null);
  return !turn || active?.turn === turn ? active : jsonFile(turnStatePath(root, session, turn), null);
}

/** Read appended complete records, retaining only cursor and user-message identity. */
export async function messageCheckpoint(path, cursor) {
  if (!path) throw Object.assign(new Error('Transcript path unavailable.'), { code: 'TRANSCRIPT_PATH_MISSING' });
  const info = await stat(path, { bigint: true }), size = Number(info.size), identity = `${info.dev}:${info.ino}`;
  const start = cursor?.path === path && cursor.identity === identity && Number.isSafeInteger(cursor.offset) && cursor.offset >= 0 && cursor.offset <= size ? cursor.offset : 0;
  let offset = start, bytesRead = 0, pending = Buffer.alloc(0), userMessage = null, userMessages = 0;
  if (size > start) for await (const chunk of createReadStream(path, { start, end: size - 1 })) {
    bytesRead += chunk.length; pending = Buffer.concat([pending, chunk]); let end;
    while ((end = pending.indexOf(10)) !== -1) {
      const position = offset, line = pending.subarray(0, end).toString('utf8');
      pending = pending.subarray(end + 1); offset += end + 1;
      if (!line.trim()) continue;
      let record; try { record = JSON.parse(line); } catch { throw new Error('Invalid transcript JSONL record.'); }
      if (record.type === 'USER_INPUT') {
        if (record.source !== 'USER_EXPLICIT') continue;
        if (typeof record.content === 'string' && record.content.trim()) {
          userMessages++;
          userMessage = createHash('sha256').update(`${path}:${identity}:${position}:${line}`).digest('hex');
        }
        continue;
      }
      const message = record.type === 'response_item' ? record.payload : record.message;
      if (!message || (message.role ?? record.type) !== 'user') continue;
      const metadata = message.internal_chat_message_metadata_passthrough?.content_item_metadata;
      if (Array.isArray(metadata) && metadata.length && !metadata.some(item => item?.provenance?.type === 'user')) continue;
      const text = typeof message.content === 'string' ? message.content.trim() : message.content?.some(block => ['text', 'input_text'].includes(block.type) && block.text?.trim());
      if (text) { userMessages++; userMessage = createHash('sha256').update(`${path}:${identity}:${position}:${line}`).digest('hex'); }
    }
  }
  return { cursor: { path, identity, offset }, userMessage, userMessages, bytesRead };
}

/** Serialize one session's state changes and recover a verified abandoned owner. */
export function withTurnLock(path, action, { home = userHome(), now = Date.now } = {}) {
  return withLocalLock(path, action, { wait: true, now, onRecovery: healed => recordLockRecovery(home, 'lock:turn', 'an abandoned turn lock', now(), healed).catch(() => {
    console.error('Geppetto could not record the abandoned turn lock recovery attempt.');
  }) });
}
