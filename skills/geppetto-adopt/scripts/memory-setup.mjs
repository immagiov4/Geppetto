import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, basename, dirname } from 'node:path';
import { atomicJson, gitOutput, jsonFile, exists, run, UsageError, rejectSymlinks as memoryWritePath } from './common.mjs';
import { memoryConfiguration } from './memory-config.mjs';
import { bucketCatalog } from './memory-index.mjs';
export const memoryQuestion = `Which memory should Geppetto use?
1. Local Git folder (recommended): ~/geppetto-memory, shared by Claude and Codex, with history of every change; link to GitHub later.
2. Private GitHub repo: the same, plus sync across machines; needs GitHub access.
3. Only Claude/Codex's own memory: separate per tool and per machine.
4. No memory.
Choose with --memory <local|github|native|none>.`;
export function memoryDescription(memory) {
  if (memory?.choice === 'native') return "Only Claude/Codex's own memory";
  if (memory?.choice === 'none') return 'No memory';
  return memory?.localPath ? `${memory.choice === 'github' ? 'Private GitHub repo' : 'Git folder'} ${memory.localPath} (${memory.repo})` : 'choice required';
}
export const memoryGit = (root, args, execute = run, options = {}) => gitOutput(root, args, { execute, label: `Memory Git ${args[0]}`, ...options });
export async function syncMemory(memory, execute = run) {
  const root = memory.localPath;
  const git = args => memoryGit(root, args, execute);
  if (await realpath(git(['rev-parse', '--show-toplevel'])) !== await realpath(root)) throw new Error('Memory needs the configured repository root');
  const remotes = git(['remote']).split(/\r?\n/).filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : null;
  if (remotes.length && !remote) throw new Error('Choose one memory remote before registering jobs');
  let branch;
  if (remote) {
    const identity = value => value.replace(/\.git$/, '').replaceAll('\\', '/');
    for (const args of [['remote', 'get-url', '--all', remote], ['remote', 'get-url', '--push', '--all', remote]]) {
      if (git(args).split(/\r?\n/).some(url => identity(url) !== identity(memory.repo))) throw new Error('Memory remote differs from memory.repo; reconcile it before installation');
    }
    git(['fetch', remote]);
    branch = git(['symbolic-ref', '--short', 'HEAD']);
    const heads = git(['for-each-ref', '--format=%(refname)', `refs/remotes/${remote}/`]);
    if (heads.split(/\r?\n/).includes(`refs/remotes/${remote}/${branch}`)) git(['pull', '--ff-only', remote, branch]);
    else if (heads) throw new Error('Memory branch has no matching remote branch; reconcile before installation');
  }
  return { git, remote, branch };
}
export { memoryWritePath };
async function seed(memory, bucket, execute) {
  await memoryWritePath(memory.localPath);
  await mkdir(memory.localPath, { recursive: true });
  if (!await exists(resolve(memory.localPath, '.git'))) memoryGit(memory.localPath, ['init', '-q'], execute);
  await syncMemory(memory, execute);
  const index = resolve(memory.localPath, 'index.md');
  await memoryWritePath(index);
  let text = await exists(index) ? await readFile(index, 'utf8') : '# Memory\n\n| Bucket | Scope | Holds |\n|---|---|---|\n';
  const catalog = await exists(index) ? bucketCatalog(text) : [];
  const paths = ['index.md'];
  for (const [name, scope, description] of [['preferences', 'global', 'Working preferences.'], [bucket, 'project', `Lessons and decision rationale for ${bucket}.`]]) {
    if (!catalog.some(entry => entry.name === name)) {
      const lines = text.trimEnd().split(/\r?\n/);
      const table = lines.findIndex(line => /^\s*\|/.test(line) && ['bucket', 'scope', 'holds'].every(key => line.toLowerCase().split('|').some(cell => cell.trim() === key)));
      const columns = lines[table].split('|').slice(1, -1).map(cell => cell.trim().toLowerCase());
      let end = table + 1;
      while (end < lines.length && /^\s*\|/.test(lines[end])) end++;
      const row = { bucket: `[${name}](buckets/${name}/index.md)`, scope, holds: description };
      lines.splice(end, 0, `| ${columns.map(key => row[key] ?? '').join(' | ')} |`);
      text = `${lines.join('\n')}\n`;
    }
    const path = `buckets/${name}/index.md`;
    await memoryWritePath(resolve(memory.localPath, path));
    if (!await exists(resolve(memory.localPath, path))) {
      await mkdir(dirname(resolve(memory.localPath, path)), { recursive: true });
      await writeFile(resolve(memory.localPath, path), `# ${name}\n${name === bucket ? '\n[Claude native memory](claude/)\n' : ''}`);
      paths.push(path);
    }
  }
  await writeFile(index, text);
  const nativeIndex = `buckets/${bucket}/claude/index.md`;
  await memoryWritePath(resolve(memory.localPath, nativeIndex));
  await mkdir(dirname(resolve(memory.localPath, nativeIndex)), { recursive: true });
  if (!await exists(resolve(memory.localPath, nativeIndex))) {
    await writeFile(resolve(memory.localPath, nativeIndex), '# Claude native memory\n');
    paths.push(nativeIndex);
  }
  memoryGit(memory.localPath, ['add', '--', ...paths], execute);
  if (memoryGit(memory.localPath, ['diff', '--cached', '--name-only', '--', ...paths], execute)) memoryGit(memory.localPath, ['-c', 'user.name=Geppetto', '-c', 'user.email=geppetto@localhost', 'commit', '--only', '-m', 'Initialize memory\n\nMemory-Event: save', '--', ...paths], execute);
}
export async function setupMemory(project, machine, { home, memoryChoice, execute = run }) {
  let memory = await memoryConfiguration(project, home);
  const fresh = memoryChoice && (memoryChoice !== memory?.choice || !memory?.localPath);
  if (memoryChoice) {
    if (['native', 'none'].includes(memoryChoice)) memory = { choice: memoryChoice };
    else if (fresh) {
      const localPath = resolve(home, 'geppetto-memory');
      memory = { choice: memoryChoice, repo: localPath, localPath };
      if (memoryChoice === 'github') {
        const account = execute('gh', ['api', 'user', '--jq', '.login'], { cwd: project });
        if (account.status !== 0 || !/^[\w-]+$/.test(account.stdout?.trim() ?? '')) throw new Error('Private GitHub memory needs gh and GitHub access; sign in with gh auth login and retry.');
        memory.repo = `https://github.com/${account.stdout.trim()}/geppetto-memory`;
      }
    }
  }
  if (!memory?.choice && !memory?.repo && !memory?.localPath) return null;
  const bucket = memory.buckets?.find(name => name !== 'preferences') ?? (basename(project).replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '') || 'project');
  if (bucket.toLowerCase() === 'preferences') throw new UsageError('Choose a project bucket through memory.buckets');
  const managed = ['local', 'github'].includes(memory.choice);
  if (managed && (memoryChoice || !memory.buckets?.length)) {
    await seed(memory, bucket, execute);
    if (memoryChoice === 'github' && !memoryGit(memory.localPath, ['remote'], execute)) {
      const result = execute('gh', ['repo', 'create', memory.repo.replace('https://github.com/', ''), '--private', '--source', memory.localPath, '--remote', 'origin'], { cwd: project });
      if (result.status !== 0) throw new Error(`Private memory creation failed: ${result.stderr?.trim() || result.error?.message}`);
      memoryGit(memory.localPath, ['push', '-u', 'origin', 'HEAD'], execute);
    }
  }
  const userPath = resolve(home, '.geppetto/config.json');
  const user = await jsonFile(userPath, {});
  const { buckets, projectBucket, ...shared } = memory;
  const linked = buckets?.length ? buckets : managed ? [bucket] : [];
  if (shared.localPath === null) delete shared.localPath;
  if (memoryChoice || (!user.memory?.choice && !user.memory?.repo && !user.memory?.localPath)) {
    user.memory = shared; await atomicJson(userPath, user);
  }
  machine.memory = user.memory;
  const configPath = resolve(project, '.geppetto/config.json');
  if (resolve(project) !== resolve(home)) {
    const local = await jsonFile(configPath, {});
    const before = JSON.stringify(local);
    if (memoryChoice && ['native', 'none'].includes(memory.choice)) local.memory = { choice: memory.choice };
    else if (managed) local.memory = { ...(memoryChoice ? {} : local.memory), buckets: linked };
    if (JSON.stringify(local) !== before) await atomicJson(configPath, local);
  }
  return ['native', 'none'].includes(memory.choice) ? null : { ...memory, buckets: linked };
}
export async function bridgeNativeMemory(project, machine, memory) {
  const path = resolve(project, '.claude/settings.local.json');
  const owned = machine.nativeMemory?.[project];
  if (!memory) {
    if (!owned) return;
    await memoryWritePath(path);
    const settings = await jsonFile(path, {});
    if (settings.autoMemoryDirectory === owned.value) {
      if (owned.previous === undefined) delete settings.autoMemoryDirectory;
      else settings.autoMemoryDirectory = owned.previous;
      await atomicJson(path, settings);
    }
    delete machine.nativeMemory[project]; return;
  }
  const bucket = memory.buckets.find(name => name.toLowerCase() !== 'preferences');
  if (!bucket || !memory.localPath) return;
  await memoryWritePath(path);
  const settings = await jsonFile(path, {});
  const value = `${resolve(memory.localPath, 'buckets', bucket, 'claude')}/`;
  if (owned && settings.autoMemoryDirectory !== owned.value) throw new Error('Claude autoMemoryDirectory changed; reconcile its ownership before installation.');
  await memoryWritePath(value); await mkdir(value, { recursive: true });
  machine.nativeMemory ??= {};
  machine.nativeMemory[project] = { previous: owned ? owned.previous : settings.autoMemoryDirectory, value };
  settings.autoMemoryDirectory = value; await atomicJson(path, settings);
}
