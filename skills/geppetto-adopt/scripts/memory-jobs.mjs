import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { exists, run } from './common.mjs';
import { syncMemory, memoryWritePath, memoryGit } from './memory-setup.mjs';
const header = '# Maintenance jobs\n\n| Machine | Job | Scheduler | Cadence | Registered |\n|---|---|---|---|---|\n';
const cell = value => {
  const text = String(value);
  if (!text.trim() || /[|\r\n]/.test(text)) throw new Error('Memory job registry fields must be nonempty single-line table cells');
  return text;
};
const format = rows => header + [...rows].sort((a, b) => `${a.machine}/${a.job}`.localeCompare(`${b.machine}/${b.job}`, 'en')).map(row => `| ${['machine', 'job', 'scheduler', 'cadence', 'registered'].map(key => cell(row[key])).join(' | ')} |\n`).join('');
function parse(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line.replace(/^\||\|$/g, '').split('|').map(text => text.trim());
    if (cells[0] === 'Machine' || cells.every(text => /^:?-+:?$/.test(text))) continue;
    if (cells.length !== 5 || cells.some(text => !text)) throw new Error('Invalid jobs.md registration table');
    rows.push(Object.fromEntries(['machine', 'job', 'scheduler', 'cadence', 'registered'].map((key, i) => [key, cells[i]])));
  }
  return rows;
}
function checkPublication({ git, remote, branch }) {
  if (!remote) return;
  const ref = `refs/remotes/${remote}/${branch}`;
  const present = git(['for-each-ref', '--format=%(refname)', ref]) === ref;
  const commits = git(['rev-list', present ? `${ref}..HEAD` : 'HEAD']).split(/\r?\n/).filter(Boolean);
  for (const commit of commits) {
    const [email, subject] = git(['show', '-s', '--format=%ae%n%s', commit]).split(/\r?\n/);
    const files = git(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commit]).split(/\r?\n/).filter(Boolean);
    const owned = subject === 'Register memory maintenance' ? files.every(path => path === 'jobs.md') : subject === 'Initialize memory' && files.every(path => path === 'index.md' || /^buckets\/[^/]+\/(?:index\.md|claude\/index\.md)$/.test(path));
    if (email !== 'geppetto@localhost' || !files.length || !owned) throw new Error('Memory has local commits requiring separate synchronization before publishing job registrations.');
  }
}
/** Prepare a registry-only commit without changing the real index or working tree. */
async function registryCommit(root, parent, text, execute) {
  const directory = await mkdtemp(resolve(tmpdir(), 'geppetto-jobs-index-'));
  const options = { env: { ...process.env, GIT_INDEX_FILE: resolve(directory, 'index') } };
  const git = (args, extra = {}) => memoryGit(root, args, execute, { ...options, ...extra });
  try {
    git(parent ? ['read-tree', parent] : ['read-tree', '--empty']);
    const blob = git(['hash-object', '-w', '--stdin'], { input: text });
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},jobs.md`]);
    return git(['-c', 'user.name=Geppetto', '-c', 'user.email=geppetto@localhost', 'commit-tree', git(['write-tree']), ...(parent ? ['-p', parent] : []), '-m', 'Register memory maintenance\n\nMemory-Event: save']);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
/** Re-evaluate competing registry writes before any scheduler side effect. */
export async function memoryJobs(memory, execute = run) {
  if (!memory?.localPath) return null;
  const root = memory.localPath, path = resolve(root, 'jobs.md');
  await memoryWritePath(path);
  async function load() {
    const state = await syncMemory(memory, execute);
    checkPublication(state);
    if (state.git(['status', '--porcelain', '--', 'jobs.md'])) throw new Error('Commit or preserve local jobs.md edits before registering maintenance.');
    const text = await exists(path) ? await readFile(path, 'utf8') : '';
    const head = execute('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root });
    const remoteHead = state.remote ? state.git(['for-each-ref', '--format=%(objectname)', `refs/remotes/${state.remote}/${state.branch}`]) : null;
    return { ...state, text, rows: parse(text), head: head.status === 0 ? head.stdout.trim() : null, remoteHead };
  }
  let state = await load();
  return {
    get rows() { return state.rows; },
    async update(change) {
      for (;;) {
        const rows = state.rows.map(row => ({ ...row }));
        const result = change(rows);
        const text = format(rows);
        const changed = text !== state.text.replaceAll('\r\n', '\n');
        if (!changed && (!state.remote || state.head === state.remoteHead)) return result;
        const commit = changed ? await registryCommit(root, state.head, text, execute) : state.head;
        if (state.remote) {
          const pushed = execute('git', ['push', state.remote, `${commit}:refs/heads/${state.branch}`], { cwd: root, timeout: 0 });
          if (pushed.status !== 0) {
            state.git(['fetch', state.remote]);
            if (state.git(['for-each-ref', '--format=%(objectname)', `refs/remotes/${state.remote}/${state.branch}`]) !== state.remoteHead) { state = await load(); continue; }
            throw new Error(`Memory Git push failed: ${pushed.stderr?.trim() || pushed.error?.message || 'unknown error'}`);
          }
        }
        if (changed) state.git(['merge', '--ff-only', commit]);
        state = await load();
        return result;
      }
    },
  };
}
