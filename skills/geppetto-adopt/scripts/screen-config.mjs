import { resolve } from 'node:path';
import { jsonFile, run, userHome } from './common.mjs';
import { samePath } from './codex-hook-trust.mjs';
import { projectRecords } from './project-records.mjs';

async function publicOrigin(root) {
  const git = run('git', ['config', '--get', 'remote.origin.url'], { cwd: root, timeout: 1000 });
  if (git.status !== 0) return false;
  const match = git.stdout.trim().match(/^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com(?::22)?\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  if (!match) return false;
  try {
    const response = await fetch('https://api.github.com/repos/' + match[1],
      { signal: AbortSignal.timeout(2000), headers: { accept: 'application/vnd.github+json' } });
    if (!response.ok) return false;
    const repo = await response.json();
    return repo.private === false && repo.full_name?.toLowerCase() === match[1].toLowerCase();
  } catch {
    return false;
  }
}

export async function screenSourceStatus(root, { home = userHome(), config } = {}) {
  config ??= await jsonFile(resolve(root, '.geppetto/config.json'), {});
  const project = root === home ? undefined : config?.screen?.shareSource;
  const key = Boolean(process.env.OPENROUTER_API_KEY);
  if (typeof project === 'boolean') return { shareSource: project, scope: 'project', key };
  const user = (await jsonFile(resolve(home, '.geppetto/config.json'), {}))?.screen?.shareSource;
  if (typeof user === 'boolean') return { shareSource: user, scope: 'user', key };
  return await publicOrigin(root) ? { shareSource: true, scope: 'public', key }
    : { shareSource: null, scope: 'unset', key };
}

export const screenChoiceReminder = 'Geppetto semantic screening: source sharing is unset. Ask once for the user default and record the answer with screen.py --user --share-source yes|no.';

export async function matchingScreenRun(root, runId, session, turn, started) {
  if (typeof runId !== 'string' || !/^[a-f\d]{32}$/.test(runId)) return false;
  const git = run('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 1500 });
  if (git.status !== 0) return false;
  return (await projectRecords(root, 'hook-events', { recover: false })).some(row =>
    row.hook === 'requirementsScreen' && row.runId === runId && row.sessionId === session &&
    row.turnId === turn && Date.parse(row.ts) >= started && row.mode === 'decisions' &&
    row.revision === git.stdout.trim() && typeof row.worktree === 'string' && samePath(root, row.worktree) &&
    (['completed', 'partial'].includes(row.status) || row.status === 'failed' &&
      ['catalog', 'decisions'].includes(row.stage)));
}
