import { readFile, realpath } from 'node:fs/promises';
import { posix, relative, resolve } from 'node:path';
import { setTimeout as yieldToTimers } from 'node:timers/promises';
import { memoryPath } from './memory-index.mjs';

async function requestBatches(stage, choices, maxBytes, requestBytes, checkCancellation) {
  if (!Number.isFinite(maxBytes)) return [choices];
  const batches = []; const pending = [choices];
  while (pending.length) {
    checkCancellation();
    const batch = pending.pop();
    const bytes = requestBytes(stage, batch);
    // Let the whole-run timer cancel CPU preparation before any provider dispatch.
    await yieldToTimers();
    checkCancellation();
    if (bytes <= maxBytes) { batches.push(batch); continue; }
    if (batch.length === 1) throw new Error('Memory classifier request exceeds its configured byte budget');
    const middle = Math.floor(batch.length / 2);
    pending.push(batch.slice(middle), batch.slice(0, middle));
  }
  return batches;
}

/** One provider-call queue shared by all branches, depths and request batches. */
export function candidateClassifier({ request, requestBytes, maxRequestBytes = Infinity, maxConcurrentRequests = 1, signal, deadlineAt = Infinity }) {
  let active = 0; const waiting = [];
  const checkCancellation = () => {
    if (signal.aborted || performance.now() >= deadlineAt) throw new Error('Memory classifier timed out or cancelled');
  };
  signal.addEventListener('abort', () => {
    for (const waiter of waiting.splice(0)) waiter.reject(new Error('Memory classifier timed out or cancelled'));
  }, { once: true });
  async function classify(stage, candidates) {
    checkCancellation();
    if (active >= maxConcurrentRequests) await new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    else active++;
    try {
      checkCancellation();
      return await request(stage, candidates, signal);
    } finally {
      const next = waiting.shift();
      if (next) next.resolve(); else active--;
    }
  }
  return async (stage, choices) => {
    if (!choices.length) return [];
    const batches = await requestBatches(stage, choices, maxRequestBytes, requestBytes, checkCancellation);
    return (await Promise.all(batches.map(batch => classify(stage, batch)))).flat();
  };
}

function documentLinks(text, bucket, document) {
  const entries = new Map();
  const prefix = `buckets/${bucket}/`;
  for (const line of text.split(/\r?\n/)) for (const link of line.matchAll(/\[([^\]]+)\]\(([^\s)]+)\)/g)) {
    let target;
    try { target = decodeURIComponent(link[2].split('#')[0]); } catch { continue; }
    if (!target || /[\\\0]/.test(target) || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(target)) continue;
    const rooted = target.startsWith(prefix);
    if (rooted) target = target.slice(prefix.length);
    if (target.endsWith('/')) target += 'index.md';
    target = posix.normalize(posix.join(rooted ? '' : posix.dirname(document), target));
    if (target.startsWith('../') || target.startsWith('buckets/') || !target.endsWith('.md')) continue;
    entries.set(target, { document: target, description: line.replace(link[0], link[1]).trim() });
  }
  return [...entries.values()];
}

/** Expand selected indexes only; page bodies never enter provider requests. */
export async function traverseMemory({ memory, buckets, classify, signal }) {
  const root = await realpath(memory.localPath);
  const visited = new Set(); const pages = new Map();
  async function visit(bucket, document = 'index.md') {
    if (signal.aborted) throw new Error('Memory classifier timed out or cancelled');
    const path = await memoryPath(memory, bucket, document);
    const identity = process.platform === 'win32' ? path.toLowerCase() : path;
    if (visited.has(identity)) return;
    visited.add(identity);
    const text = await readFile(path, 'utf8');
    const entries = new Map();
    const currentDocument = relative(resolve(root, 'buckets', bucket), path).replaceAll('\\', '/');
    for (const entry of documentLinks(text, bucket, currentDocument)) {
      const target = await memoryPath(memory, bucket, entry.document);
      const id = relative(root, target).replaceAll('\\', '/');
      entries.set(id, { ...entry, id });
    }
    const chosen = await classify('pages', [...entries.values()].map(({ id, description }) => ({ id, description })));
    await Promise.all(chosen.map(async selection => {
      const entry = entries.get(selection.id);
      if (posix.basename(entry.id) === 'index.md') return visit(bucket, entry.document);
      const previous = pages.get(selection.id);
      // Shared leaves retain a stable reason regardless of branch completion order.
      if (!previous || selection.reason.localeCompare(previous.reason, 'en') < 0) pages.set(selection.id, selection);
    }));
  }
  await Promise.all(buckets.map(bucket => visit(bucket)));
  return [...pages.values()].sort((a, b) => a.id.localeCompare(b.id, 'en'));
}
