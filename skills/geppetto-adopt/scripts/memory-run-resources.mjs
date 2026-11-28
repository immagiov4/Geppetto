import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { atomicJson, gitOutput, jsonFile, rejectSymlinks } from './common.mjs';
import { machinePath } from './health.mjs';
import { processIsAlive } from './local-lock.mjs';

const runRoot = home => machinePath(home, 'worktrees');
const runPath = (home, name) => resolve(runRoot(home), name);
const runName = /^memory-run-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const missing = error => { if (error.code !== 'ENOENT') throw error; };

export async function registerMemoryRun(home, id, repo) {
  const path = runPath(home, 'memory-run-' + id);
  await rejectSymlinks(path);
  await mkdir(runRoot(home), { recursive: true, mode: 0o700 });
  await mkdir(path, { mode: 0o700 });
  // Publish the owner before a worktree or a profile containing credentials can exist.
  await atomicJson(resolve(path, 'owner.json'), { pid: process.pid, repo }, { mode: 0o600 });
  return path;
}

async function orphanOwner(path) {
  const marker = resolve(path, 'owner.json');
  if (!(await lstat(marker).catch(missing))?.isFile()) return null;
  const owner = await jsonFile(marker, null);
  if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1 || owner.pid > 0x7fffffff ||
      typeof owner.repo !== 'string' || !isAbsolute(owner.repo) || processIsAlive(owner.pid)) return null;
  return owner;
}

export async function orphanMemoryRuns(home) {
  const root = runRoot(home);
  await rejectSymlinks(root);
  const entries = await readdir(root, { withFileTypes: true }).catch(missing);
  const names = [];
  for (const entry of entries ?? []) {
    if (entry.isDirectory() && runName.test(entry.name) && await orphanOwner(runPath(home, entry.name))) names.push(entry.name);
  }
  return names.sort();
}

export async function removeMemoryRun(path, repo) {
  const runner = resolve(path, 'runner'), checkout = resolve(path, 'checkout');
  await rejectSymlinks(runner);
  // Remove credential copies even if Git cannot currently clean up its registration.
  await rm(runner, { recursive: true, force: true });
  await rejectSymlinks(checkout);
  const git = args => gitOutput(repo, args, { detail: false });
  const listing = git(['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain']);
  for (const record of listing.split(/\r?\n\r?\n/)) {
    const [entry, ...fields] = record.split(/\r?\n/);
    if (!entry.startsWith('worktree ') || resolve(entry.slice('worktree '.length)) !== checkout) continue;
    if (!fields.includes('detached')) throw new Error('The memory run checkout is no longer detached.');
    git(['worktree', 'remove', '--force', '--', checkout]);
  }
  await rm(path, { recursive: true, force: true });
}

export async function removeOrphanMemoryRuns(home, names) {
  for (const name of names) {
    const path = runPath(home, name);
    await rejectSymlinks(path);
    const owner = await orphanOwner(path);
    if (owner) await removeMemoryRun(path, owner.repo);
  }
}
