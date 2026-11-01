import { createReadStream } from 'node:fs';
import { stat, mkdir, writeFile, readFile, link, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';

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
      const message = record.type === 'response_item' ? record.payload : record.message;
      if (!message || (message.role ?? record.type) !== 'user') continue;
      const text = typeof message.content === 'string' ? message.content.trim() : message.content?.some(block => ['text', 'input_text'].includes(block.type) && block.text?.trim());
      if (text) { userMessages++; userMessage = createHash('sha256').update(`${path}:${identity}:${position}:${line}`).digest('hex'); }
    }
  }
  return { cursor: { path, identity, offset }, userMessage, userMessages, bytesRead };
}


/** Serialize one session's state changes; an abandoned owner is reported for recovery. */
export async function withTurnLock(path, action) {
  const owner = `${path}.${process.pid}.${randomUUID()}`, lockPollMs = 10;
  await mkdir(dirname(path), { recursive: true }); await writeFile(owner, String(process.pid), { mode: 0o600 });
  try {
    for (;;) {
      try { await link(owner, path); break; } catch (error) { if (error.code !== 'EEXIST') throw error; }
      let pid; try { pid = Number(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') throw new Error(`Inactive turn-state lock owner ${pid}; verify it has exited before removing ${path}.`); throw error; }
      await delay(lockPollMs);
    }
    try { return await action(); } finally { await unlink(path); }
  } finally { await unlink(owner); }
}
