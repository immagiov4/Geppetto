import { readFileSync } from 'node:fs';
import { mkdir, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { cli, isMain, UsageError, projectRoot, userHome, jsonFile, atomicJson, ignoreLocalFiles, contained } from './common.mjs';
import { memorySettings } from './memory-config.mjs';
import { logHookEvent } from './hook-events.mjs';
import { redact } from './signal.mjs';
import { memoryCatalog, memoryIndex } from './memory-index.mjs';

function writtenPaths(event) {
  const tool = typeof event.tool_name === 'string' ? event.tool_name.split(/[.:/]/).at(-1).toLowerCase() : '';
  const input = event.tool_input;
  if (tool === 'apply_patch') {
    const patch = typeof input === 'string' ? input : input?.input ?? input?.patch ?? '';
    return typeof patch === 'string' ? [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)\r?$/gm)].map(match => match[1].trim()) : [];
  }
  if (!['write', 'edit', 'multiedit'].includes(tool)) return [];
  return [input?.file_path ?? input?.path, ...(input?.edits ?? []).map(edit => edit.file_path ?? edit.path)].filter(path => typeof path === 'string');
}

/** Reuse PostToolUse dispatch; native writes need no provider or learning threshold. */
export async function nativeMemoryEvent(event, { home = userHome() } = {}) {
  if (process.env.GEPPETTO_LEARNING_CHILD === '1' || typeof event.session_id !== 'string' || !event.session_id || !['UserPromptSubmit', 'PostToolUse'].includes(event.hook_event_name)) return {};
  const paths = event.hook_event_name === 'PostToolUse' ? writtenPaths(event) : [];
  if (event.hook_event_name === 'PostToolUse' && (!paths.length || event.tool_response?.isError || event.tool_error)) return {};
  const project = await projectRoot(event.cwd ?? '.');
  const memory = await memorySettings(project, home);
  if (!memory?.repo || !memory.localPath) return {};
  const session = createHash('sha256').update(event.session_id).digest('hex');
  const state = resolve(project, '.geppetto/hook-state', session);
  const turnPath = resolve(state, 'native-turn.json');
  if (event.hook_event_name === 'UserPromptSubmit') {
    await ignoreLocalFiles(project, ['/hook-state/', '/hook-events.jsonl']);
    await atomicJson(turnPath, { turn: event.turn_id ?? randomUUID() }); return {};
  }
  const user = await jsonFile(resolve(home, '.claude/settings.json'), {});
  const shared = await jsonFile(resolve(project, '.claude/settings.json'), {});
  const local = await jsonFile(resolve(project, '.claude/settings.local.json'), {});
  const native = local.autoMemoryDirectory ?? shared.autoMemoryDirectory ?? user.autoMemoryDirectory;
  const directory = native ? resolve(/^~[\\/]/.test(native) ? home : project, native.replace(/^~[\\/]/, '')) : null;
  const codex = resolve(process.env.CODEX_HOME || resolve(home, '.codex'), 'memories');
  const touched = paths.map(path => resolve(event.cwd ?? project, path)).filter(path => contained(codex, path) || directory && contained(directory, path) || /\/\.claude\/projects\/[^/]+\/memory\//.test(path.replaceAll('\\', '/')));
  if (!touched.length) return {};
  const turn = event.turn_id ?? (await jsonFile(turnPath, {})).turn ?? 'session';
  const marker = resolve(state, `native-${createHash('sha256').update(turn).digest('hex')}`);
  await mkdir(state, { recursive: true });
  await ignoreLocalFiles(project, ['/hook-state/', '/hook-events.jsonl']);
  let lock;
  try { lock = await open(marker, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') return {}; throw error; }
  await lock.close();
  const inBucket = directory && contained(resolve(memory.localPath, 'buckets'), directory) && touched.some(path => contained(directory, path));
  const text = inBucket ? 'You saved to native memory inside bucket memory; keep the bucket index in step through $geppetto-memory.' : 'You saved to native memory. If it is a durable, generalizable lesson, also save it to bucket memory through $geppetto-memory.';
  try { await logHookEvent(project, { hook: 'nativeMemory', event: 'PostToolUse', session, turn, inBucket: Boolean(inBucket), injectedBytes: Buffer.byteLength(text), modelCalls: 0, costUsd: 0 }, event); }
  catch (error) { await unlink(marker); throw error; }
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } };
}

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
  if (process.env.GEPPETTO_LEARNING_CHILD === '1') return {};
  const { home } = options;
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new UsageError('Memory hook input must be an event object');
  const name = event.hook_event_name ?? 'SessionStart';
  if (name !== 'SessionStart') return {};
  const project = await projectRoot(event.cwd ?? '.');
  let text; let status = 'ok';
  try {
    const memory = await memorySettings(project, home);
    if (!memory) return {};
    text = await sessionContext(memory);
  } catch (error) { status = 'unavailable'; text = `Memory is configured but unavailable: ${redact(error.message).replace(/\s+/g, ' ')}`; }
  await logHookEvent(project, { hook: 'memory', event: name, status, injectedBytes: Buffer.byteLength(text), modelCalls: 0, costUsd: 0 }, event);
  return { hookSpecificOutput: { hookEventName: name, additionalContext: text } };
}

export async function main(args) {
  if (args.length === 1 && args[0] === '--check-credential') {
    const present = Boolean(process.env.OPENROUTER_API_KEY);
    console.log(JSON.stringify({ credential: present ? 'present' : 'missing', source: present ? 'process-environment' : null, providerAuthentication: 'not-verified' }));
    return present ? 0 : 1;
  }
  if (args.length) throw new UsageError('Usage: memory-hook.mjs [--check-credential] < hook-event.json');
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8')); } catch { throw new UsageError('Memory hook input must be JSON'); }
  console.log(JSON.stringify(await handleMemoryEvent(event))); return 0;
}

if (isMain(import.meta.url)) await cli(main);
