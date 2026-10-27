import { readFile, mkdir, lstat, unlink, open, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { cli, isMain, parseArgs, UsageError, exists, filesUnder, contained, jsonFile, atomicJson, userHome, ignoreLocalFiles } from './common.mjs';
import { reconcileMachine } from './machine.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const portable = path => path.split(sep).join('/');
const generatedPaths = new Set(['AGENTS.md', 'CLAUDE.md', '.geppetto/config.json', '.geppetto/authorizations', '.claude/settings.json', '.codex/hooks.json', '.github/workflows/pr-gate.yml']);

// A copied skill must not turn an installation path into a write outside its root.
async function safePath(root, path) {
  if (!contained(root, path) || resolve(root) === resolve(path)) throw new Error(`${path}:1: Install path escapes its root`);
  for (let current = resolve(path); ; current = dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`${current}:1: Reconcile symbolic link before installation`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current === dirname(current)) break;
  }
}

function validateManifest(manifest, root, statePath) {
  if (manifest.version !== 1 || !manifest.installations || typeof manifest.installations !== 'object' || Array.isArray(manifest.installations)) throw new Error(`${statePath}:1: Invalid install manifest`);
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
  let provenance = manifest.source;
  if (!original && !provenance) {
    const location = portable(scriptDir);
    let ownerRoot;
    if (location.endsWith('/.geppetto/bin')) ownerRoot = resolve(scriptDir, '../..');
    else if (/\/(?:\.agents|\.claude)\/skills\/geppetto-adopt\/scripts$/.test(location)) ownerRoot = resolve(scriptDir, '../../../..');
    if (ownerRoot) provenance = (await jsonFile(resolve(ownerRoot, '.geppetto/install.json'), {})).source;
  }
  const sourceRoot = original ? candidate : provenance?.path;
  if (!sourceRoot || typeof sourceRoot !== 'string') throw new Error(`${statePath}:1: No recorded package source; run the installer from the Geppetto source checkout`);
  const metadata = await jsonFile(resolve(sourceRoot, 'package.json'));
  if (metadata.name !== 'geppetto' || typeof metadata.version !== 'string' || !await exists(resolve(sourceRoot, 'skills/geppetto-adopt/scripts/install.mjs'))) throw new Error(`${statePath}:1: Recorded package source is not a Geppetto package`);
  return { path: resolve(sourceRoot), version: metadata.version };
}

async function desiredFiles(target, uninstall, root, source, previous, generated) {
  const desired = new Map();
  if (!uninstall) {
    const sourceRoot = source.path;
    const skillsRoot = resolve(sourceRoot, 'skills');
    const skillDir = target === 'claude' ? '.claude/skills' : '.agents/skills';
    for (const source of await filesUnder(skillsRoot)) desired.set(portable(relative(root, resolve(root, skillDir, relative(skillsRoot, source)))), await readFile(source));
    const scriptsRoot = resolve(sourceRoot, 'skills/geppetto-adopt/scripts');
    for (const source of await filesUnder(scriptsRoot)) {
      if (source.endsWith('.mjs') && resolve(root) === resolve(sourceRoot)) {
        const module = `../../skills/geppetto-adopt/scripts/${portable(relative(scriptsRoot, source))}`;
        desired.set(`.geppetto/bin/${portable(relative(scriptsRoot, source))}`, Buffer.from(`export * from '${module}';\nimport * as script from '${module}';\nimport { cli, isMain } from '${module.replace(/[^/]+$/, 'common.mjs')}';\nif (isMain(import.meta.url) && script.main) await cli(script.main);\n`));
      } else if (source.endsWith('.mjs')) desired.set(`.geppetto/bin/${portable(relative(scriptsRoot, source))}`, await readFile(source));
    }
    desired.set('.geppetto/bin/message-context.cjs', await readFile(resolve(skillsRoot, 'requirements-blast-radius/scripts/message-context.cjs')));
    for (const path of new Set([...(previous.generated ?? []), ...generated])) {
      await safePath(root, resolve(root, path));
      if (path === '.geppetto/authorizations' && !generated.includes(path) && !await exists(resolve(root, path))) continue;
      let content = await readFile(resolve(root, path));
      if (['.codex/hooks.json', '.claude/settings.json'].includes(path) && /\.geppetto[/\\]bin[/\\]|geppetto-adopt[/\\]scripts[/\\]/.test(content.toString())) {
        const settings = JSON.parse(content);
        for (const [event, groups] of Object.entries(settings.hooks ?? {})) settings.hooks[event] = groups.map(group => ({ ...group, hooks: group.hooks.filter(hook => !/\.geppetto[/\\]bin[/\\]|geppetto-adopt[/\\]scripts[/\\]/.test(hook.command ?? '')) })).filter(group => group.hooks.length);
        content = Buffer.from(`${JSON.stringify(settings, null, 2)}\n`);
      }
      desired.set(path, content);
    }
  }
  return desired;
}

async function planInstallation({ root, manifest, target, desired, acceptedGenerated }) {
  const previous = manifest.installations[target]?.files ?? {};
  const changes = []; const nextFiles = {}; const observed = new Map(); const sharedUpdates = new Map(); const overlaps = []; const conflicts = [];
  const otherFiles = Object.entries(manifest.installations).filter(([key]) => key !== target).map(([, entry]) => entry.files ?? {});
  for (const path of new Set([...Object.keys(previous), ...desired.keys()])) {
    const destination = resolve(root, path);
    await safePath(root, destination);
    const currentHash = await exists(destination) ? hash(await readFile(destination)) : null;
    observed.set(path, currentHash);
    const content = desired.get(path); const desiredHash = content !== undefined ? hash(content) : null;
    if (previous[path] && currentHash && currentHash !== previous[path] && !acceptedGenerated.includes(path)) conflicts.push(`${destination}:1: Local edits need reconciliation; preserve or merge them before retrying`);
    const otherHash = otherFiles.map(files => files[path]).find(Boolean);
    if (!previous[path] && !otherHash && currentHash) {
      overlaps.push({ path, currentHash, desiredHash, disposition: currentHash === desiredHash ? 'adopt-identical' : 'conflict' });
      if (currentHash !== desiredHash) conflicts.push(`${destination}:1: Existing file is not owned; reconcile it before installation`);
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

async function applyInstallation({ root, manifest, statePath, target, uninstall, source, generated, plan }) {
  const { changes, nextFiles, observed, sharedUpdates, otherFiles } = plan;
  await mkdir(dirname(statePath), { recursive: true });
  const lockPath = `${statePath}.lock`; let lock;
  try { lock = await open(lockPath, 'wx'); } catch (error) { if (error.code === 'EEXIST') throw new Error(`${lockPath}:1: Another installation is active`); throw error; }
  try {
    // Detect a second installer that completed after the preflight read.
    const latest = await jsonFile(statePath, { version: 1, installations: {} });
    if (JSON.stringify(latest) !== JSON.stringify(manifest)) throw new Error(`${statePath}:1: Installation state changed; rerun reconciliation`);
    for (const [path, before] of observed) {
      const destination = resolve(root, path);
      await safePath(root, destination);
      const current = await exists(destination) ? hash(await readFile(destination)) : null;
      if (before !== current) throw new Error(`${destination}:1: Local file changed during reconciliation; rerun installation`);
    }
    if (!uninstall) {
      await safePath(root, resolve(root, '.geppetto/.gitignore'));
      await ignoreLocalFiles(root, ['/authorizations']);
    }
    for (const change of changes) {
      const destination = resolve(root, change.path);
      await safePath(root, destination);
      if (change.action === 'remove') await unlink(destination);
      else {
        await mkdir(dirname(destination), { recursive: true });
        const temp = `${destination}.${process.pid}.tmp`;
        await writeFile(temp, change.content, { flag: 'wx' }); await rename(temp, destination);
      }
    }
    for (const files of otherFiles) for (const [path, ownedHash] of sharedUpdates) if (files[path]) files[path] = ownedHash;
    if (uninstall) delete manifest.installations[target];
    else {
      manifest.source = source;
      manifest.installations[target] = { files: nextFiles, generated: generated.filter(path => nextFiles[path]) };
    }
    await atomicJson(statePath, manifest);
  } finally { await lock.close(); await unlink(lockPath); }
}

export async function main(args) {
  const opts = parseArgs(args, { values: ['--target', '--project'], repeat: ['--record-generated'], flags: ['--user', '--dry-run', '--uninstall', '--plugin-hooks'] });
  const target = opts['--target'];
  if (opts._.length || !['claude', 'codex', 'agents'].includes(target) || Boolean(opts['--project']) === Boolean(opts['--user'])) throw new UsageError('Usage: install.mjs --target <claude|codex|agents> (--project <dir> | --user) [--dry-run] [--uninstall]');
  const root = resolve(opts['--user'] ? userHome() : opts['--project']);
  const statePath = resolve(root, '.geppetto/install.json');
  await safePath(root, statePath);
  const manifest = await jsonFile(statePath, { version: 1, installations: {} });
  validateManifest(manifest, root, statePath);
  const recorded = opts['--record-generated'] ?? [];
  if (recorded.some(path => !generatedPaths.has(path)) || (opts['--uninstall'] && recorded.length)) throw new UsageError('--record-generated accepts adoption files only and requires installation');
  const generated = [...new Set([...(manifest.installations[target]?.generated ?? []), ...recorded])].sort();
  const source = opts['--uninstall'] ? null : await packageSource(manifest, statePath);
  const desired = await desiredFiles(target, opts['--uninstall'], root, source, manifest.installations[target] ?? {}, recorded);
  const plan = await planInstallation({ root, manifest, target, desired, acceptedGenerated: recorded });
  console.log(`${opts['--dry-run'] ? 'Dry run: ' : ''}${opts['--uninstall'] ? 'Uninstall' : 'Install'} ${target}: ${plan.changes.length} file changes`);
  if (opts['--dry-run']) for (const change of plan.changes) console.log(`${change.action} ${change.path}`);
  if (opts['--dry-run'] || (opts['--uninstall'] && !manifest.installations[target])) return 0;
  await applyInstallation({ root, manifest, statePath, target, uninstall: opts['--uninstall'], source, generated, plan });
  const machine = await reconcileMachine(root, target, source, { pluginHooks: opts['--plugin-hooks'], uninstall: opts['--uninstall'] });
  console.log(`Machine resources: ${Object.keys(machine.hooks).join(', ')} hooks; ${Object.keys(machine.jobs).join(', ')} jobs; OpenRouter ${process.env.OPENROUTER_API_KEY ? 'available' : 'key missing'}`);
  return 0;
}

if (isMain(import.meta.url)) await cli(main);
