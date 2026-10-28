import { readFile, lstat, unlink } from 'node:fs/promises';
import { gitOutput } from './common.mjs';
import { learningFilePath, LearningScopeError } from './learner-tools.mjs';
export const learningGit = (root, args, options = {}) => gitOutput(root, args, { prefix: ['-c', 'core.hooksPath='], trim: false, label: 'Learning Git operation', detail: false, ...options });

/** Capture permitted working files through a private index; never stage or commit the user's checkout. */
export async function learningContext(root, indexPath) {
  const sourceHead = learningGit(root, ['rev-parse', 'HEAD']).trim();
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  const names = new Set([
    ...learningGit(root, ['diff', '--no-renames', '--name-only', '-z', sourceHead, '--']).split('\0'),
    ...learningGit(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ].filter(Boolean));
  let excludedChanges = 0;
  try {
    learningGit(root, ['read-tree', sourceHead], { env });
    for (const name of names) {
      let path;
      try { path = await learningFilePath(root, name); }
      catch (error) { if (!(error instanceof LearningScopeError)) throw error; excludedChanges++; continue; }
      const treeEntry = learningGit(root, ['ls-tree', sourceHead, '--', name]);
      const stagedEntry = learningGit(root, ['ls-files', '--stage', '--', name]);
      if (/^160000 /.test(treeEntry) || /^160000 /.test(stagedEntry)) { excludedChanges++; continue; }
      let info;
      try { info = await lstat(path); }
      catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        learningGit(root, ['update-index', '--force-remove', '--', name], { env }); continue;
      }
      if (info.isDirectory() && /^100(?:644|755) /.test(treeEntry)) {
        learningGit(root, ['update-index', '--force-remove', '--', name], { env }); continue;
      }
      if (!info.isFile()) throw new Error('Learning context requires regular project files.');
      const contents = await readFile(path);
      const object = learningGit(root, ['hash-object', '-w', `--path=${name}`, '--stdin'], { input: contents }).trim();
      const trackedMode = stagedEntry.slice(0, 6);
      const mode = process.platform === 'win32' ? (trackedMode || '100644') : (info.mode & 0o111 ? '100755' : '100644');
      learningGit(root, ['update-index', '--add', '--replace', '--cacheinfo', `${mode},${object},${name}`], { env });
    }
    const tree = learningGit(root, ['write-tree'], { env }).trim();
    const originalTree = learningGit(root, ['rev-parse', `${sourceHead}^{tree}`]).trim();
    const baseline = tree === originalTree ? sourceHead
      : learningGit(root, ['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', sourceHead, '-m', 'learning: capture current project context']).trim();
    return { sourceHead, baseline, excludedChanges };
  } finally {
    await unlink(indexPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
