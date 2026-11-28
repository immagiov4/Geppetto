import { randomUUID } from 'node:crypto';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const lockGraceMs = 10 * 60 * 1000;
const pollInterval = 10;

export function processIsAlive(pid) {
  try { process.kill(pid, 0); }
  catch (error) {
    if (error.code === 'EPERM') return true;
    if (error.code === 'ESRCH') return false;
    throw error;
  }
  return true;
}

async function deadOwner(path, now) {
  let file;
  try { file = await open(path, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return 'gone'; throw error; }
  try {
    const age = now - (await file.stat()).mtimeMs;
    const pid = Number(await file.readFile('utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid Geppetto lock owner.');
    if (processIsAlive(pid)) return 'live';
    return age >= lockGraceMs ? 'stale' : 'recent';
  } finally { await file.close(); }
}

/** A hard link publishes a complete owner PID. The recovery lock serializes stale unlink. */
export async function withLocalLock(path, action, { wait = false, now = Date.now, onRecovery } = {}) {
  const owner = path + '.' + process.pid + '.' + randomUUID();
  await mkdir(dirname(path), { recursive: true });
  const file = await open(owner, 'wx', 0o600);
  let acquired = false, reclaimed = false;
  try {
    try { await file.writeFile(String(process.pid)); } finally { await file.close(); }
    for (;;) {
      try { await link(owner, path); acquired = true; break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      let status = await deadOwner(path, now());
      if (status === 'gone') continue;
      if (status === 'stale') {
        const removed = await withLocalLock(path + '.recovery', async () => {
          // A competitor may already have released or replaced the previously observed lock.
          status = await deadOwner(path, now());
          if (status !== 'stale') return false;
          try { await unlink(path); }
          catch (error) { await onRecovery?.(false); throw error; }
          return true;
        }, { now });
        if (removed) { reclaimed = true; continue; }
        if (status === 'gone') continue;
      }
      if (!wait) {
        if (reclaimed) await onRecovery?.(true);
        return undefined;
      }
      if (status === 'recent') throw new Error('Geppetto lock owner exited within the 10-minute recovery grace period.');
      await delay(pollInterval);
    }
    if (reclaimed) await onRecovery?.(true);
    return await action();
  } finally {
    try { if (acquired) await unlink(path); } finally { await unlink(owner); }
  }
}
