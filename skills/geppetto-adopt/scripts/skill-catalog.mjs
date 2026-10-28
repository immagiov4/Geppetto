import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
function field(frontmatter, key) {
  const lines = frontmatter.split(/\r?\n/); const index = lines.findIndex(line => line.startsWith(`${key}:`));
  if (index < 0) return '';
  const value = lines[index].slice(key.length + 1).trim();
  if (/^[>|][-+]?\s*$/.test(value)) {
    const body = [];
    for (const line of lines.slice(index + 1)) { if (line && !/^\s/.test(line)) break; body.push(line.trim()); }
    return body.join(' ').trim();
  }
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value.replace(/^'|'$/g, '').replaceAll("''", "'");
}

/** Project owners precede user catalogs; only name, description and a local pointer are retained. */
export async function skillCatalog(project, home, settings, env = process.env) {
  const codex = env.CODEX_HOME ?? resolve(home, '.codex');
  const bundled = import.meta.url.includes('/geppetto-adopt/scripts/') ? fileURLToPath(new URL('../../', import.meta.url)) : null;
  const roots = [resolve(project, '.agents/skills'), resolve(project, '.claude/skills'), ...(settings.skillDirs ?? []).map(path => resolve(project, path)), resolve(home, '.agents/skills'), resolve(codex, 'skills'), resolve(codex, 'skills/.system'), resolve(home, '.claude/skills'), ...(bundled ? [bundled] : [])];
  const found = new Map();
  for (const root of new Set(roots)) {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      const path = resolve(root, entry.name, 'SKILL.md'); let text;
      try { text = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const metadata = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.replace(/^\uFEFF/, ''))?.[1];
      if (!metadata) continue;
      const name = field(metadata, 'name'), description = field(metadata, 'description');
      if (name && description && !found.has(name)) found.set(name, { id: createHash('sha256').update(name).digest('hex'), name, description, path: path.replaceAll('\\', '/') });
    }
  }
  return [...found.values()];
}

export function validateSkillSelectorSettings(settings) {
  if (typeof settings.model !== 'string' || !settings.model.trim()) throw new Error('skillSelector needs an owner-selected model');
  if (!Number.isFinite(settings.threshold) || settings.threshold < 0 || settings.threshold > 1) throw new Error('skillSelector.threshold must be between 0 and 1');
  for (const field of ['timeoutMs', 'batchSize']) if (!Number.isSafeInteger(settings[field]) || settings[field] <= 0) throw new Error(`skillSelector.${field} must be a positive integer`);
  if (settings.timeoutMs >= 30000) throw new Error('skillSelector.timeoutMs must fit the enclosing 30-second hook deadline');
  for (const field of ['maxRequestBytes', 'maxConcurrentRequests', 'maxSkills']) {
    if (field === 'maxSkills' && settings[field] === null) continue;
    if (settings[field] !== undefined && (!Number.isSafeInteger(settings[field]) || settings[field] <= 0)) throw new Error(`skillSelector.${field} must be a positive integer`);
  }
  if (settings.maxCostUsd != null && (!Number.isFinite(settings.maxCostUsd) || settings.maxCostUsd < 0 || !/^\d+(?:\.\d{1,6})?$/.test(String(settings.maxCostUsd)))) throw new Error('skillSelector.maxCostUsd must be nonnegative USD (at most six decimals)');
  if (settings.skillDirs !== undefined && (!Array.isArray(settings.skillDirs) || settings.skillDirs.some(path => typeof path !== 'string' || !path.trim()))) throw new Error('skillSelector.skillDirs must contain directory paths');
  if (['key', 'apiKey', 'api_key', 'secret'].some(field => field in settings)) throw new Error('Skill selector credentials belong in the environment or secret store');
}

export function suggestSkills(selected, candidates, settings) {
  selected.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const chosen = settings.maxSkills == null ? selected : selected.slice(0, settings.maxSkills);
  const owners = new Map(candidates.map(candidate => [candidate.id, candidate]));
  return chosen.length ? `Skills suggested for this message. Read the relevant SKILL.md before acting; also discover other useful skills when needed:\n${chosen.map(entry => { const skill = owners.get(entry.id); return `- ${skill.name}: ${skill.path}`; }).join('\n')}` : '';
}
