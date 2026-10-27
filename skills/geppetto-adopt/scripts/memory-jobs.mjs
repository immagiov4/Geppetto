import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { exists, run } from './common.mjs';
import { syncMemory, memoryWritePath } from './memory-setup.mjs';

const header = '# Maintenance jobs\n\n| Machine | Job | Scheduler | Cadence | Registered |\n|---|---|---|---|---|\n';
const cell = value => {
  const text = String(value);
  if (!text.trim() || /[|\r\n]/.test(text)) throw new Error('Memory job registry fields must be nonempty single-line table cells');
  return text;
};

/** Synchronize the shared registry before deciding which machine attaches work. */
export async function memoryJobs(memory, execute = run) {
  if (!memory?.localPath) return null;
  const root = memory.localPath;
  const { git, remote, branch } = await syncMemory(memory, execute);
  const path = resolve(root, 'jobs.md');
  await memoryWritePath(path);
  const original = await exists(path) ? await readFile(path, 'utf8') : '';
  const rows = [];
  for (const line of original.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line.replace(/^\||\|$/g, '').split('|').map(text => text.trim());
    if (cells[0] === 'Machine' || cells.every(text => /^:?-+:?$/.test(text))) continue;
    if (cells.length !== 5 || cells.some(text => !text)) throw new Error('Invalid jobs.md registration table');
    rows.push(Object.fromEntries(['machine', 'job', 'scheduler', 'cadence', 'registered'].map((key, i) => [key, cells[i]])));
  }
  return {
    rows,
    async save() {
      const text = header + [...rows].sort((a, b) => `${a.machine}/${a.job}`.localeCompare(`${b.machine}/${b.job}`, 'en')).map(row => `| ${['machine', 'job', 'scheduler', 'cadence', 'registered'].map(key => cell(row[key])).join(' | ')} |\n`).join('');
      if (text !== original) {
        await writeFile(path, text);
        git(['add', '--', 'jobs.md']);
        if (git(['diff', '--cached', '--name-only', '--', 'jobs.md'])) git(['-c', 'user.name=Geppetto', '-c', 'user.email=geppetto@localhost', 'commit', '--only', '-m', 'Register memory maintenance\n\nMemory-Event: save', '--', 'jobs.md']);
      }
      // Retry an interrupted publication even if the local table already matches.
      if (remote) git(['push', remote, `HEAD:refs/heads/${branch}`]);
    },
  };
}
