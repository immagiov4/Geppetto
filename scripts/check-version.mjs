import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { versions } from './version.mjs';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim();
try {
  if (process.argv[2] === 'commit') {
    const entries = versions('');
    if (new Set(entries.map(([, v]) => v)).size !== 1) throw new Error(entries.map(([f, v]) => `${f}: ${v}`).join('\n'));
  } else {
    const updates = readFileSync(0, 'utf8').trim().split('\n').filter(Boolean);
    for (const update of updates) {
      const [, localSha, remoteRef] = update.trim().split(/\s+/);
      if (remoteRef !== 'refs/heads/main' || /^0+$/.test(localSha)) continue;
      const remote = process.argv[3];
      const remoteSha = git('ls-remote', remote, 'refs/heads/main').split(/\s+/)[0];
      if (!remoteSha) throw new Error('Cannot determine remote main version');
      const files = git('diff', '--name-only', remoteSha, localSha, '--', 'skills/', '.claude-plugin/', '.codex-plugin/', '.agents/plugins/');
      if (files && versions(remoteSha)[0][1] === versions(localSha)[0][1]) throw new Error(`Version bump required for ${files.replace(/\n/g, ', ')}; run node scripts/bump-version.mjs <x.y.z>`);
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }

