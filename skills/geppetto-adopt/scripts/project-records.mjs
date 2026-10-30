import { readFile, readdir, mkdir, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { run, rejectSymlinks } from './common.mjs';
import { signalProvenance } from './learning-privacy.mjs';

const journals = ['signals', 'turns', 'reviews', 'reads', 'hook-events', 'category-proposals'];
const digest = text => createHash('sha256').update(text).digest('hex');
const lines = text => text.split('\n').filter(line => line.trim()).map(JSON.parse);

/** Runtime data belongs to the repository; configuration and active gates belong to the checkout. */
export function projectDataPath(root, name) {
  const result = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root });
  if (result.status !== 0 && existsSync(resolve(root, '.git'))) throw new Error(`Cannot resolve shared Geppetto storage: ${result.stderr || result.error?.message}`);
  return resolve(result.status === 0 ? resolve(result.stdout.trim(), 'geppetto') : resolve(root, '.geppetto'), name);
}

async function readOptional(path) {
  await rejectSymlinks(path);
  try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

/** Immutable imports make repeated/concurrent migration safe and leave the originals intact. */
export async function recoverProjectRecords(root) {
  const directory = projectDataPath(root, '');
  if (directory === resolve(root, '.geppetto')) return directory;
  const listing = run('git', ['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain'], { cwd: root });
  if (listing.status !== 0) throw new Error(`Cannot discover legacy Geppetto records: ${listing.stderr}`);
  const roots = listing.stdout.split(/\r?\n/).filter(part => part.startsWith('worktree ')).map(part => part.slice(9)).map(path => path.startsWith('"') ? JSON.parse(path) : path);
  const imports = resolve(directory, 'legacy'); await rejectSymlinks(imports); await mkdir(imports, { recursive: true });
  for (const worktree of roots) for (const name of [...journals, 'learning']) {
    const path = resolve(worktree, `.geppetto/${name}.${name === 'learning' ? 'json' : 'jsonl'}`);
    let text = await readOptional(path); if (!text.trim()) continue;
    const target = resolve(imports, `${name}-${digest(worktree + '\0' + text)}.json`);
    if (existsSync(target)) continue;
    if (name === 'signals') { text = (await Promise.all(lines(text).map(row => signalProvenance(worktree, row)))).map(JSON.stringify).join('\n'); }
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ worktree: resolve(worktree), name, text, modifiedAt: (await stat(path)).mtimeMs }), { flag: 'wx', mode: 0o600 });
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
    if (currentWorktree && row.worktree && resolve(row.worktree) !== resolve(root)) continue;
    unique.set(JSON.stringify(row), row);
  }
  return [...unique.values()].sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0));
}

export async function learningState(root) {
  const directory = await recoverProjectRecords(root), path = resolve(directory, 'learning.json');
  if (existsSync(path) || directory === resolve(root, '.geppetto')) return { path, state: JSON.parse(await readOptional(path) || '{}') };
  const imported = [];
  for (const file of await readdir(resolve(directory, 'legacy'))) if (file.startsWith('learning-') && file.endsWith('.json')) imported.push(JSON.parse(await readOptional(resolve(directory, 'legacy', file))));
  // Legacy results are retained individually; the latest run supplies the initial shared progress.
  imported.sort((a, b) => a.modifiedAt - b.modifiedAt);
  return { path, state: JSON.parse(imported.at(-1)?.text ?? '{}') };
}
