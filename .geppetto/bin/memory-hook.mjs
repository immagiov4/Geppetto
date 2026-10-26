import { readFileSync } from 'node:fs';
import { cli, isMain, UsageError, projectRoot } from './common.mjs';
import { memorySettings } from './memory-config.mjs';
import { logHookEvent } from './hook-events.mjs';
import { redact } from './signal.mjs';
import { memoryCatalog, memoryIndex } from './memory-index.mjs';
import { classifyMemory } from './memory-classifier.mjs';

async function sessionContext(memory) {
  const catalog = await memoryCatalog(memory);
  const global = catalog.filter(bucket => bucket.scope === 'global'); const project = catalog.filter(bucket => bucket.scope !== 'global');
  const parts = [`Memories live here: ${memory.localPath} (${memory.repo}). Read and update them through $geppetto-memory.`, 'Global buckets:', ...global.map(bucket => `${bucket.name} — ${bucket.description}`), 'Project buckets:', ...project.map(bucket => `${bucket.name} — ${bucket.description}`)];
  for (const bucket of memory.buckets.filter(name => name.toLowerCase() !== 'private')) {
    let index;
    try { index = await memoryIndex(memory, bucket); }
    catch (error) { if (error.code !== 'ENOENT') throw error; index = `Unavailable: configured bucket index is missing (${bucket}).`; }
    parts.push(`PROJECT bucket index (${bucket}):\n${index}`);
  }
  return parts.join('\n');
}

export async function handleMemoryEvent(event, options = {}) {
  const { home } = options;
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new UsageError('Memory hook input must be an event object');
  const name = event.hook_event_name ?? 'SessionStart';
  const project = await projectRoot(event.cwd ?? '.');
  if (name === 'UserPromptSubmit') return classifyMemory(event, { ...options, project });
  if (name !== 'SessionStart') return {};
  let text; let status = 'ok';
  try {
    const memory = await memorySettings(project, home);
    if (!memory) return {};
    text = await sessionContext(memory);
  } catch (error) { status = 'unavailable'; text = `Memory is configured but unavailable: ${redact(error.message).replace(/\s+/g, ' ')}`; }
  await logHookEvent(project, { hook: 'memory', event: name, status, injectedBytes: Buffer.byteLength(text), modelCalls: 0, costUsd: 0 });
  return { hookSpecificOutput: { hookEventName: name, additionalContext: text } };
}

export async function main(args) {
  if (args.length) throw new UsageError('Usage: memory-hook.mjs < hook-event.json');
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8')); } catch { throw new UsageError('Memory hook input must be JSON'); }
  console.log(JSON.stringify(await handleMemoryEvent(event))); return 0;
}

if (isMain(import.meta.url)) await cli(main);
