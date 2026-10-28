import { readFile, mkdir, unlink, rmdir, open, writeFile, rename, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { cli, isMain, parseArgs, UsageError, exists, rejectSymlinks, filesUnder, filterHooks, contained, jsonFile, atomicJson, userHome, ignoreLocalFiles, defaultConfig, run, gitOutput } from './common.mjs';
import { reconcileMachine } from './machine.mjs';
import { memoryConfiguration } from './memory-config.mjs';
import { memoryQuestion, memoryDescription } from './memory-setup.mjs';
import { maintenanceJobs } from './maintenance.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const portable = path => path.split(sep).join('/');
const generatedPaths = new Set(['AGENTS.md', 'CLAUDE.md', '.geppetto/config.json', '.geppetto/authorizations', '.claude/settings.json', '.codex/hooks.json', '.github/workflows/pr-gate.yml']);

// A copied skill must not turn an installation path into a write outside its root.
async function safePath(root, path) {
  if (!contained(root, path) || resolve(root) === resolve(path)) throw new Error(`${path}:1: Install path escapes its root`);
  await rejectSymlinks(path);
}

function validateManifest(manifest, root, statePath) {
  if (manifest.version !== 1 || !manifest.installations || typeof manifest.installations !== 'object' || Array.isArray(manifest.installations)) throw new Error(`${statePath}:1: Invalid install manifest`);
  for (const path of manifest.removed ?? []) if (typeof path !== 'string' || (!/^(?:\.agents\/skills\/|\.claude\/skills\/|\.geppetto\/bin\/)/.test(path) && !generatedPaths.has(path)) || !contained(root, resolve(root, path)) || portable(relative(root, resolve(root, path))) !== path) throw new Error(`${statePath}:1: Invalid retired path`);
  for (const [owner, entry] of Object.entries(manifest.installations)) {
    if (!['claude', 'codex', 'agents'].includes(owner) || !entry || !entry.files || typeof entry.files !== 'object' || Array.isArray(entry.files)) throw new Error(`${statePath}:1: Invalid install owner`);
    const prefix = owner === 'claude' ? '.claude/skills/' : '.agents/skills/';
    for (const [path, ownedHash] of Object.entries(entry.files)) {
      if ((!path.startsWith(prefix) && !path.startsWith('.geppetto/bin/') && !generatedPaths.has(path)) || !contained(root, resolve(root, path)) || portable(relative(root, resolve(root, path))) !== path) throw new Error(`${statePath}:1: Owned path escapes its root or target: ${path}`);
      if (!/^[a-f\d]{64}$/.test(ownedHash)) throw new Error(`${statePath}:1: Invalid owned hash for ${path}`);
    }
    if (entry.generated !== undefined && (!Array.isArray(entry.generated) || entry.generated.some(path => !generatedPaths.has(path) || !entry.files[path]))) throw new Error(`${statePath}:1: Invalid generated ownership`);
  }
}

async function packageSource(manifest, statePath) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(scriptDir, '../../..');
  // Only the original package layout may discover itself; copies use recorded provenance.
  const original = resolve(candidate, 'skills/geppetto-adopt/scripts') === scriptDir && await exists(resolve(candidate, 'package.json'));
  const provenance = original ? null : manifest.source ?? (await jsonFile(resolve(scriptDir, '../../../../.geppetto/install.json'), {})).source;
  const sourceRoot = original ? candidate : provenance?.path;
  if (!sourceRoot || typeof sourceRoot !== 'string') throw new Error(`${statePath}:1: No recorded package source; run the installer from the Geppetto source checkout`);
  const metadata = await jsonFile(resolve(sourceRoot, 'package.json'));
  if (metadata.name !== 'geppetto' || typeof metadata.version !== 'string' || !await exists(resolve(sourceRoot, 'skills/geppetto-adopt/scripts/install.mjs'))) throw new Error(`${statePath}:1: Recorded package source is not a Geppetto package`);
  return { path: resolve(sourceRoot), version: metadata.version };
}

async function desiredFiles({ target, uninstall, root, source, previous, generated, plugin, gateSha }) {
  const desired = new Map();
  if (uninstall) return desired;
  const sourceRoot = source.path;
  const skillsRoot = resolve(sourceRoot, 'skills');
  const skillDir = target === 'claude' ? '.claude/skills' : '.agents/skills';
  if (!plugin) for (const source of await filesUnder(skillsRoot)) desired.set(portable(relative(root, resolve(root, skillDir, relative(skillsRoot, source)))), await readFile(source));
  const workflow = '.github/workflows/pr-gate.yml';
  if (gateSha) desired.set(workflow, Buffer.from((await readFile(resolve(sourceRoot, 'skills/geppetto-adopt/assets/templates/ci/pr-gate.yml'), 'utf8')).replaceAll('{{GEPPETTO_SHA}}', gateSha)));
  if (!await exists(resolve(root, '.geppetto/config.json'))) desired.set('.geppetto/config.json', Buffer.from(`${JSON.stringify(defaultConfig(), null, 2)}\n`));
  else if (previous.files?.['.geppetto/config.json']) desired.set('.geppetto/config.json', await readFile(resolve(root, '.geppetto/config.json')));
  for (const path of new Set([...(previous.generated ?? []), ...generated])) {
    if (desired.has(path)) continue;
    await safePath(root, resolve(root, path));
    if (path === '.geppetto/authorizations' && !generated.includes(path) && !await exists(resolve(root, path))) continue;
    let content = await readFile(resolve(root, path));
    if (['.codex/hooks.json', '.claude/settings.json'].includes(path) && /\.geppetto[/\\]bin[/\\]|geppetto-adopt[/\\]scripts[/\\]/.test(content.toString())) {
      const settings = JSON.parse(content);
      filterHooks(settings, hook => !/\.geppetto[/\\]bin[/\\]|geppetto-adopt[/\\]scripts[/\\]/.test(hook.command ?? ''));
      content = Buffer.from(`${JSON.stringify(settings, null, 2)}\n`);
    }
    desired.set(path, content);
  }
  return desired;
}

async function planInstallation({ root, manifest, target, desired, acceptedGenerated, retireShared }) {
  const previous = manifest.installations[target]?.files ?? {};
  const changes = []; const nextFiles = {}; const observed = new Map(); const sharedUpdates = new Map(); const overlaps = []; const conflicts = [];
  const otherFiles = Object.entries(manifest.installations).filter(([key]) => key !== target).map(([, entry]) => entry.files ?? {});
  for (const path of new Set([...Object.keys(previous), ...desired.keys()])) {
    const destination = resolve(root, path);
    await safePath(root, destination);
    const current = await exists(destination) ? await readFile(destination) : null;
    const currentHash = current ? hash(current) : null;
    observed.set(path, currentHash);
    const content = desired.get(path); const desiredHash = content !== undefined ? hash(content) : null;
    if (previous[path] && currentHash && currentHash !== previous[path] && !acceptedGenerated.includes(path)) conflicts.push(`${destination}:1: Local edits need reconciliation; preserve or merge them before retrying`);
    const otherHash = retireShared && path.startsWith('.geppetto/bin/') ? null : otherFiles.map(files => files[path]).find(Boolean);
    if (!previous[path] && !otherHash && currentHash) {
      // Git checkouts can normalize text line endings without changing the owned content.
      const identical = currentHash === desiredHash || (content && isUtf8(current) && isUtf8(content) && !current.includes(0) && !content.includes(0) && current.toString().replaceAll('\r\n', '\n') === content.toString().replaceAll('\r\n', '\n'));
      overlaps.push({ path, currentHash, desiredHash, disposition: identical ? 'adopt-identical' : 'conflict' });
      if (!identical) conflicts.push(`${destination}:1: Existing file is not owned; reconcile it before installation`);
    }
    if (!acceptedGenerated.includes(path) && otherFiles.some(files => files[path] && currentHash && files[path] !== currentHash)) conflicts.push(`${destination}:1: Shared file has local edits or inconsistent ownership; reconcile it before installation`);
    if (otherHash && desiredHash) sharedUpdates.set(path, desiredHash);
    if (content !== undefined) {
      nextFiles[path] = desiredHash;
      if (currentHash !== desiredHash) changes.push({ action: 'copy', path, content });
    } else if (currentHash && !otherHash) changes.push({ action: 'remove', path });
  }
  if (overlaps.length) {
    console.log('Unowned overlaps (SHA-256):\npath | installed | proposed | disposition');
    for (const overlap of overlaps) console.log(`${overlap.path} | ${overlap.currentHash} | ${overlap.desiredHash} | ${overlap.disposition}`);
  }
  if (conflicts.length) throw new Error(conflicts.join('\n'));
  return { changes, nextFiles, observed, sharedUpdates, otherFiles };
}

async function applyInstallation({ root, manifest, statePath, uninstall, source, plans }) {
  const changes = [...new Map(plans.flatMap(({ plan }) => plan.changes.map(change => [change.path, change]))).values()];
  await mkdir(dirname(statePath), { recursive: true });
  const lockPath = `${statePath}.lock`; let lock;
  try { lock = await open(lockPath, 'wx'); } catch (error) { if (error.code === 'EEXIST') throw new Error(`${lockPath}:1: Another installation is active`); throw error; }
  try {
    // Detect a second installer that completed after the preflight read.
    const latest = await jsonFile(statePath, { version: 1, installations: {} });
    if (JSON.stringify(latest) !== JSON.stringify(manifest)) throw new Error(`${statePath}:1: Installation state changed; rerun reconciliation`);
    for (const { plan } of plans) for (const [path, before] of plan.observed) {
      const destination = resolve(root, path);
      await safePath(root, destination);
      const current = await exists(destination) ? hash(await readFile(destination)) : null;
      if (before !== current) throw new Error(`${destination}:1: Local file changed during reconciliation; rerun installation`);
    }
    if (!uninstall) {
      await safePath(root, resolve(root, '.geppetto/.gitignore'));
      await ignoreLocalFiles(root, ['/authorizations', '/install.json']);
      if (run('git', ['rev-parse', '--git-dir'], { cwd: root }).status === 0) gitOutput(root, ['rm', '--cached', '--ignore-unmatch', '--', '.geppetto/install.json']);
    }
    for (const change of changes) {
      const destination = resolve(root, change.path);
      await safePath(root, destination);
      if (change.action === 'remove') {
        await unlink(destination);
      }
      else {
        await mkdir(dirname(destination), { recursive: true });
        const temp = `${destination}.${process.pid}.tmp`;
        await writeFile(temp, change.content, { flag: 'wx' }); await rename(temp, destination);
      }
    }
    try { await rmdir(resolve(root, '.geppetto/bin')); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
    manifest.removed = [...new Set([...(manifest.removed ?? []), ...changes.filter(change => change.action === 'remove').map(change => change.path)])];
    for (const { target, generated, plugin, plan } of plans) {
      for (const files of plan.otherFiles) for (const [path, ownedHash] of plan.sharedUpdates) if (files[path]) files[path] = ownedHash;
      if (uninstall) delete manifest.installations[target];
      else manifest.installations[target] = { files: plan.nextFiles, generated: generated.filter(path => plan.nextFiles[path]), plugin };
    }
    if (!uninstall) manifest.source = source;
    await atomicJson(statePath, manifest);
  } finally { await lock.close(); await unlink(lockPath); }
}

export async function main(args) {
  const opts = parseArgs(args, { values: ['--target', '--project', '--scheduler-jobs', '--memory', '--gate-sha'], repeat: ['--record-generated', '--add-job'], flags: ['--user', '--dry-run', '--uninstall', '--plugin-hooks', '--begin', '--commit'] });
  const target = opts['--target'];
  if (opts._.length || !['claude', 'codex', 'agents'].includes(target) || Boolean(opts['--project']) === Boolean(opts['--user'])) throw new UsageError('Usage: install.mjs --target <claude|codex|agents> (--project <dir> | --user) [--dry-run] [--uninstall]');
  const root = resolve(opts['--user'] ? userHome() : opts['--project']);
  const statePath = resolve(root, '.geppetto/install.json');
  await safePath(root, statePath);
  const manifest = await jsonFile(statePath, { version: 1, installations: {} });
  validateManifest(manifest, root, statePath);
  if (opts['--begin'] || opts['--commit']) {
    if (opts['--user'] || opts['--uninstall'] || (opts['--begin'] && opts['--commit'])) throw new UsageError('--begin and --commit are separate project adoption steps');
    return installationGit(root, manifest, opts);
  }
  if (opts['--memory'] !== undefined && !['local', 'github', 'native', 'none'].includes(opts['--memory'])) throw new UsageError('--memory must be local, github, native or none');
  if ((opts['--add-job'] ?? []).some(name => !maintenanceJobs.includes(name))) throw new UsageError('--add-job must name curate-skills or maintain-memory');
  const memory = await memoryConfiguration(root);
  if (!opts['--uninstall'] && !opts['--memory'] && !memory?.choice && !memory?.repo && !memory?.localPath) throw new Error(memoryQuestion);
  const recorded = opts['--record-generated'] ?? [];
  if (recorded.some(path => !generatedPaths.has(path)) || (opts['--uninstall'] && recorded.length)) throw new UsageError('--record-generated accepts adoption files only and requires installation');
  const generated = [...new Set([...(manifest.installations[target]?.generated ?? []), ...recorded, ...(!opts['--user'] && !opts['--uninstall'] ? ['.github/workflows/pr-gate.yml'] : [])])].sort();
  const source = opts['--uninstall'] ? null : await packageSource(manifest, statePath);
  const plugin = Boolean(opts['--plugin-hooks'] || manifest.installations[target]?.plugin);
  let gateSha = !opts['--user'] && !opts['--uninstall'] ? opts['--gate-sha'] : null;
  if (!opts['--user'] && !opts['--uninstall']) {
    if (!gateSha && await exists(resolve(source.path, '.git'))) gateSha = run('git', ['rev-parse', 'HEAD'], { cwd: source.path }).stdout?.trim();
    if (!/^[a-f\d]{40}$/i.test(gateSha ?? '')) throw new UsageError('Project CI needs an immutable Geppetto commit; pass --gate-sha <40-character reviewed SHA> for a package without Git metadata');
  }
  const plans = [];
  // Preflight every installed consumer before retiring their shared scripts.
  for (const owner of new Set([target, ...(!opts['--uninstall'] ? Object.keys(manifest.installations) : [])])) {
    const entry = manifest.installations[owner] ?? {};
    const ownerGenerated = owner === target ? generated : entry.generated ?? [];
    const ownerPlugin = owner === target ? plugin : Boolean(entry.plugin);
    const desired = await desiredFiles({ target: owner, uninstall: opts['--uninstall'], root, source, previous: entry, generated: owner === target ? recorded : [], plugin: ownerPlugin, gateSha });
    const plan = await planInstallation({ root, manifest, target: owner, desired, acceptedGenerated: recorded, retireShared: !opts['--uninstall'] });
    plans.push({ target: owner, generated: ownerGenerated, plugin: ownerPlugin, plan });
  }
  const changes = [...new Map(plans.flatMap(({ plan }) => plan.changes.map(change => [change.path, change]))).values()];
  console.log(`${opts['--dry-run'] ? 'Dry run: ' : ''}${opts['--uninstall'] ? 'Uninstall' : 'Install'} ${target}: ${changes.length} file changes`);
  if (opts['--dry-run']) for (const change of changes) console.log(`${change.action} ${change.path}`);
  if (opts['--dry-run']) {
    const choice = opts['--memory'];
    const preview = choice && choice !== memory?.choice ? { choice, localPath: resolve(userHome(), 'geppetto-memory'), repo: choice === 'github' ? 'private GitHub repository' : resolve(userHome(), 'geppetto-memory') } : memory;
    console.log(`Memory: ${memoryDescription(preview)}; change with --memory <local|github|native|none>.`);
  }
  if (opts['--dry-run']) return 0;
  if (!opts['--uninstall']) await applyInstallation({ root, manifest, statePath, uninstall: false, source, plans });
  let machine;
  try { for (const owner of plans) machine = await reconcileMachine(root, owner.target, source, { pluginHooks: owner.plugin, uninstall: opts['--uninstall'], uninstallMemory: ['native', 'none'].includes(memory?.choice) ? null : memory, memoryChoice: opts['--memory'], addJobs: opts['--add-job'], jobs: opts['--scheduler-jobs'] ? await jsonFile(opts['--scheduler-jobs']) : {} }); }
  catch (error) {
    if (!['EACCES', 'EPERM'].includes(error.code ?? error.cause?.code)) throw error;
    const retry = [process.execPath, fileURLToPath(import.meta.url), ...args.map((arg, index) => args[index - 1] === '--project' ? root : arg)].map(arg => `'${arg.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`).join(' ');
    console.error(`Machine registration blocked by permissions; run outside the sandbox: ${process.platform === 'win32' ? '& ' : ''}${retry}`);
    return 1;
  } finally {
    if (!opts['--uninstall']) {
      const path = '.geppetto/config.json';
      const currentManifest = await jsonFile(statePath);
      for (const entry of Object.values(currentManifest.installations)) if (entry.files[path]) entry.files[path] = hash(await readFile(resolve(root, path)));
      await atomicJson(statePath, currentManifest);
    }
  }
  if (opts['--uninstall']) await applyInstallation({ root, manifest, statePath, uninstall: true, source, plans });
  console.log(`Machine resources: ${Object.keys(machine.hooks).join(', ')} hooks; ${Object.keys(machine.jobs).join(', ')} jobs; OpenRouter ${process.env.OPENROUTER_API_KEY ? 'available for requirements screening' : 'key missing for requirements screening'}`);
  console.log(`Memory: ${memoryDescription(await memoryConfiguration(root))}; change with --memory <local|github|native|none>.`);
  for (const [name, job] of Object.entries(machine.jobs)) if (job.status === 'scheduled-elsewhere') console.log(`${name}: already scheduled on ${job.machine}; --add-job ${name} attaches another here.`);
  for (const [name, job] of Object.entries(machine.jobs)) if (job.status === 'pending-elsewhere') console.log(`${name}: registration pending on ${job.machine}; finish or remove that installation before attaching another.`);
  return 0;
}

async function installationGit(root, manifest, opts) {
  const git = args => gitOutput(root, args, { label: 'Installation Git operation' });
  const branch = 'geppetto-install';
  if (opts['--dry-run']) { console.log(`Dry run: ${opts['--begin'] ? 'create' : 'commit owned files on'} ${branch}`); return 0; }
  if (opts['--begin']) {
    const repository = run('git', ['rev-parse', '--git-dir'], { cwd: root, timeout: 0 });
    if (repository.status !== 0) git(['init', '--quiet', '--initial-branch', branch]);
    if (git(['branch', '--show-current']) !== branch) git(['switch', '-c', branch]);
    return 0;
  }
  if (git(['branch', '--show-current']) !== branch) throw new Error(`Complete adoption on ${branch}; run --begin first`);
  const files = [...new Set(Object.values(manifest.installations).flatMap(entry => Object.keys(entry.files)))].filter(path => path !== '.geppetto/authorizations');
  if (!files.length) throw new Error('No owned installation to commit');
  const removed = (manifest.removed ?? []).filter(path => !files.includes(path));
  for (const path of removed) if (await exists(resolve(root, path))) throw new Error(`${path}:1: Retired file was recreated; reconcile it before committing`);
  const head = run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root }).status === 0;
  const trackedRemoved = removed.filter(path => git(['ls-files', '--', path]) || (head && git(['ls-tree', '--name-only', 'HEAD', '--', path])));
  const registry = '.geppetto/install.json';
  const paths = [...files, ...trackedRemoved, '.geppetto/.gitignore'];
  const directory = await mkdtemp(resolve(tmpdir(), 'geppetto-install-'));
  const env = { ...process.env, GIT_INDEX_FILE: resolve(directory, 'index') };
  const isolated = args => gitOutput(root, args, { env, label: 'Installation commit' });
  try {
    isolated(['read-tree', head ? 'HEAD' : '--empty']);
    isolated(['add', '-f', '--', ...paths]);
    isolated(['rm', '--cached', '--ignore-unmatch', '--', registry]);
    if (isolated(['diff', '--cached', '--name-only'])) isolated(['commit', '-m', 'Install Geppetto']);
    git(['reset', '--quiet', 'HEAD', '--', ...paths, registry]);
  } finally { await rm(directory, { recursive: true, force: true }); }
  delete manifest.removed; await atomicJson(resolve(root, registry), manifest);
  return 0;
}
if (isMain(import.meta.url)) await cli(main);
