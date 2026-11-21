import { readFile, readdir, mkdir, writeFile, rename, unlink, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { run, rejectSymlinks } from './common.mjs';

const journals = ['signals', 'turns', 'reviews', 'reads', 'hook-events', 'category-proposals', 'metrics'];
const digest = text => createHash('sha256').update(text).digest('hex');
const lines = text => text.split('\n').filter(line => line.trim()).map(JSON.parse);

/** Runtime data belongs to the repository; configuration and active gates belong to the checkout. */
export function projectDataPath(root, name) {
  const result = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, timeout: 2500 });
  if (result.status !== 0 && existsSync(resolve(root, '.git'))) throw new Error(`Cannot resolve shared Geppetto storage: ${result.stderr || result.error?.message}`);
  return resolve(result.status === 0 ? resolve(result.stdout.trim(), 'geppetto') : resolve(root, '.geppetto'), name);
}

async function readOptional(path) {
  await rejectSymlinks(path);
  try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

export function worktreePaths(root, execute = run) {
  const listing = execute('git', ['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain'], { cwd: root, timeout: 2500 });
  if (listing.status !== 0) throw new Error(listing.error?.code ?? 'Git worktree discovery failed');
  return listing.stdout.split(/\r?\n/).filter(line => line.startsWith('worktree ')).map(line => line.slice(9)).map(path => path.startsWith('"') ? JSON.parse(path) : path);
}
/** Immutable imports make repeated/concurrent migration safe and leave the originals intact. */
async function recoverProjectRecords(root) {
  const directory = projectDataPath(root, '');
  if (directory === resolve(root, '.geppetto')) return directory;
  const roots = worktreePaths(root);
  const imports = resolve(directory, 'legacy'); await rejectSymlinks(imports); await mkdir(imports, { recursive: true });
  for (const worktree of roots) for (const name of journals) {
    const path = resolve(worktree, `.geppetto/${name}.${name === 'learning' ? 'json' : 'jsonl'}`);
    let text = await readOptional(path); if (!text.trim()) continue;
    const target = resolve(imports, `${name}-${digest(worktree + '\0' + text)}.json`);
    if (existsSync(target)) continue;
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ worktree: resolve(worktree), name, text }), { flag: 'wx', mode: 0o600 });
      await rename(temp, target);
    } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  return directory;
}

export async function projectRecords(root, name, { currentWorktree = false } = {}) {
  if (!journals.includes(name)) throw new Error(`Unknown Geppetto journal: ${name}`);
  const directory = await recoverProjectRecords(root), records = [];
  if (directory !== resolve(root, '.geppetto')) {
    for (const file of (await readdir(resolve(directory, 'legacy'))).sort()) {
      if (!file.startsWith(`${name}-`) || !file.endsWith('.json')) continue;
      const imported = JSON.parse(await readOptional(resolve(directory, 'legacy', file)));
      records.push(...lines(imported.text).map(row => ({ ...row, worktree: row.worktree ?? imported.worktree })));
    }
  }
  records.push(...lines(await readOptional(resolve(directory, `${name}.jsonl`))));
  const unique = new Map();
  for (const row of records) {
    if (currentWorktree && row.worktree && resolve(row.worktree) !== resolve(root)) {
      try { if (await realpath(row.worktree) !== await realpath(root)) continue; }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    }
    unique.set(JSON.stringify(row), row);
  }
  return [...unique.values()].sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0));
}
