import { readFile, readdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contained } from './common.mjs';
const minimumPrivateLineCharacters = 20;
export const normalizePrivateText = text => text.toLowerCase().replace(/\s+/g, ' ').trim();
function evidencePath(name, base) {
  let path;
  try { path = /^file:/i.test(name) ? fileURLToPath(name) : resolve(base, name); }
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
  }
  if (!value || typeof value !== 'object') return false;
  const directory = value.workdir ?? value.cwd;
  const base = typeof directory === 'string' ? resolve(cwd, directory) : cwd;
  return Object.entries(value).some(([key, child]) => privateEvidence(key, privateRoot, base) || privateEvidence(child, privateRoot, base) || base !== cwd && privateEvidence(child, privateRoot, cwd));
}
/** Read locally only; matched private text never enters diagnostics or provider evidence. */
export async function privateContent(privateRoot) {
  const lines = new Set();
  async function visit(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else for (const raw of (await readFile(path, 'utf8')).split(/\r?\n/)) {
        const line = normalizePrivateText(raw);
        if (line.replace(/\s/g, '').length >= minimumPrivateLineCharacters) lines.add(line);
      }
    }
  }
  if (privateRoot) await visit(privateRoot);
  return [...lines];
}
