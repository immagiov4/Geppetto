import { readFile, readdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contained } from './common.mjs';
import { memorySettings } from './memory-config.mjs';
const minimumPrivateLineCharacters = 20;
export const normalizePrivateText = text => text.toLowerCase().replace(/\s+/g, ' ').trim();
function evidencePath(name, base) {
  let path; try { path = /^file:/i.test(name) ? fileURLToPath(name) : resolve(base, name); }
  catch { path = resolve(base, name); }
  try { return realpathSync(path); } catch { return path; }
}
/** Shell arguments are best-effort provenance; output retention also checks private content. */
export function privateEvidence(value, privateRoot = null, cwd = process.cwd()) {
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object' && privateEvidence(parsed, privateRoot, cwd)) return true; } catch {}
    const bases = [cwd];
    for (const match of value.matchAll(/"(?:workdir|cwd)"\s*:\s*("(?:\\.|[^"\\])*")/g)) bases.push(resolve(cwd, JSON.parse(match[1])));
    const text = value.replaceAll('\\', '/');
    const tokens = [text, ...Array.from(text.matchAll(/"([^"\n]+)"|'([^'\n]+)'|([^\s"'`{}()[\],;=]+)/g), match => match[1] ?? match[2] ?? match[3])];
    return [...new Set(tokens)].some(token => /\bbuckets\/private(?:\/|["'\s]|$)/i.test(posix.normalize(token))
      || privateRoot && bases.some(base => contained(evidencePath(privateRoot, cwd), evidencePath(token, base))));
  } if (!value || typeof value !== 'object') return false;
  const directory = value.workdir ?? value.cwd;
  const base = typeof directory === 'string' ? resolve(cwd, directory) : cwd;
  return Object.entries(value).some(([key, child]) => privateEvidence(key, privateRoot, base) || privateEvidence(child, privateRoot, base) || base !== cwd && privateEvidence(child, privateRoot, cwd)); }
/** Only tool inputs establish access; prose and tool outputs may merely mention paths. */
export function privateTranscriptEvidence(record, privateRoot, cwd) {
  const message = record.type === 'response_item' ? record.payload : record.message;
  const calls = ['function_call', 'custom_tool_call'].includes(message?.type) ? [message.arguments ?? message.input] : (Array.isArray(message?.content) ? message.content.filter(block => block.type === 'tool_use').map(block => block.input) : []);
  return calls.some(input => privateEvidence((typeof input === 'string' ? input : JSON.stringify(input)).replace(/["']!buckets[/\\]private[^"']*["']/gi, ''), privateRoot, cwd)); }
/** Read locally only; matched private text never enters diagnostics or provider evidence. */
export async function privateContent(privateRoot) {
  const lines = new Set(); async function visit(directory) {
    let entries; try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else for (const raw of (await readFile(path, 'utf8')).split(/\r?\n/)) {
        const line = normalizePrivateText(raw);
        if (line.replace(/\s/g, '').length >= minimumPrivateLineCharacters) lines.add(line);
      }
    }
  } if (privateRoot) await visit(privateRoot);
  return [...lines];
}
/** Preserve source exclusion before a checkout and its private aliases disappear. */
export async function signalProvenance(root, row) {
  if (!row.transcript_path) return row;
  try {
    const memory = await memorySettings(root), privateRoot = memory?.localPath ? resolve(memory.localPath, 'buckets/private') : null;
    let cwd = row.worktree ?? root;
    for (const line of (await readFile(row.transcript_path, 'utf8')).split('\n').filter(line => line.trim())) {
      const record = JSON.parse(line), directory = record.cwd ?? (['session_meta', 'turn_context'].includes(record.type) ? record.payload?.cwd : null);
      if (typeof directory === 'string') cwd = resolve(cwd, directory);
      if (privateTranscriptEvidence(record, privateRoot, cwd)) return { ...row, sourcePrivacy: 'private' };
    }
    return { ...row, sourcePrivacy: 'public' };
  } catch (error) { return { ...row, sourcePrivacy: 'unavailable', sourceError: error.code ?? 'invalid-transcript' }; }
}
