import { setTimeout as yieldToTimers } from 'node:timers/promises';
import { skillSelectionPayload } from './skill-provider.mjs';
/** Split by count and serialized bytes, then share one cancellable provider queue. */
export async function selectSkillBatches(candidates, settings, request, signal, deadlineAt) {
  const check = () => { if (signal.aborted || performance.now() >= deadlineAt) throw new Error('Skill selector timed out or cancelled'); };
  const pending = [], batches = [];
  for (let start = 0; start < candidates.length; start += settings.batchSize) pending.push(candidates.slice(start, start + settings.batchSize));
  for (const choices of pending) {
    check();
    const oversized = settings.maxRequestBytes !== undefined && Buffer.byteLength(JSON.stringify(skillSelectionPayload({ model: settings.model, prompt: settings.prompt, candidates: choices }))) > settings.maxRequestBytes;
    if (settings.maxRequestBytes !== undefined) { await yieldToTimers(); check(); }
    if (!oversized) { batches.push(choices); continue; }
    if (choices.length === 1) throw new Error('Skill selector request exceeds its configured byte budget');
    const middle = Math.floor(choices.length / 2);
    pending.push(choices.slice(0, middle), choices.slice(middle));
  }
  const selected = [];
  async function work() {
    while (batches.length) { check(); selected.push(...await request(batches.shift(), signal)); }
  }
  await Promise.all(Array.from({ length: Math.min(settings.maxConcurrentRequests ?? 1, batches.length) }, work));
  return selected;
}
