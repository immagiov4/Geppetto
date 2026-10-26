import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { run } from './common.mjs';
import { learningFilePath } from './learning-files.mjs';

function git(root, args) {
  const result = run('git', ['-c', 'core.hooksPath=', ...args], { cwd: root });
  if (result.status !== 0) throw new Error('Learning branch operation failed; inspect the local worktree before retrying');
  return result.stdout;
}

export async function learningWorktree(root, id) {
  const branch = `geppetto/learn-${id}`;
  const path = resolve(root, '.geppetto/learning/worktrees', id);
  await mkdir(resolve(path, '..'), { recursive: true });
  git(root, ['worktree', 'add', '--quiet', '-b', branch, path, 'HEAD']);
  return { path, branch };
}

export async function finishLearningWorktree(worktree, writeApproval) {
  const ignored = git(worktree.path, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  if (ignored.length) throw new Error('Learning output is ignored by Git; reconcile retention before finalizing');
  const paths = git(worktree.path, ['ls-files', '--modified', '--deleted', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  for (const path of new Set(paths)) {
    await learningFilePath(worktree.path, path);
    git(worktree.path, ['add', '--', path]);
  }
  const changes = git(worktree.path, ['diff', '--cached', '--name-only']).trim();
  if (!changes) return { ...worktree, status: 'unchanged' };
  if (writeApproval) return { ...worktree, status: 'staged', files: changes.split('\n') };
  git(worktree.path, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'learn: retain reusable project improvement']);
  return { ...worktree, status: 'committed', commit: git(worktree.path, ['rev-parse', 'HEAD']).trim(), files: changes.split('\n') };
}
