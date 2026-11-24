import { mkdir, readFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson, claimFile, exists, jsonFile, run, userHome } from './common.mjs';
import { connectCodex, hookTrust, samePath } from './codex-hook-trust.mjs';
import { maintenanceJobs, maintenanceLauncherText, maintenanceRegistrationStatus } from './maintenance.mjs';
import { memoryConfiguration } from './memory-config.mjs';
import { parseJobRegistry } from './memory-jobs.mjs';
import { learningCommand } from './learn-runner.mjs';
import { logHookEvent } from './hook-events.mjs';

const upstream = 'https://api.github.com/repos/immagiov4/Geppetto';
const pluginId = 'geppetto@geppetto';
const pluginRepair = {
  claude: ['claude plugin marketplace update geppetto', 'claude plugin update geppetto@geppetto'],
  codex: ['codex plugin marketplace upgrade geppetto', 'codex plugin add geppetto@geppetto'],
  antigravity: ['git -C ~/.gemini/config/plugins/geppetto pull --ff-only', 'Reinstall or update ~/.gemini/config/plugins/geppetto from the published release'],
};
const installer = fileURLToPath(new URL('./install.mjs', import.meta.url));

async function installedPlugin(target, root, home = userHome()) {
  if (target === 'antigravity') {
    const manifest = await jsonFile(resolve(home, '.gemini/config/plugins/geppetto/plugin.json'), null);
    if (!manifest || manifest.disabled === true) return undefined;
    const config = await jsonFile(resolve(home, '.gemini/config/config.json'), {});
    if (config.plugins?.geppetto?.enabled === false) return undefined;
    return manifest;
  }
  const args = target === 'codex' ? ['plugin', 'list', '--marketplace', 'geppetto', '--json'] : ['plugin', 'list', '--json'];
  const command = learningCommand(target);
  if (!command) throw new Error(`Unable to find the ${target} CLI`);
  const result = run(command.executable, [...command.prefix, ...args], { cwd: root });
  if (result.status !== 0) throw new Error(`Unable to list ${target} plugins`);
  const inventory = JSON.parse(result.stdout);
  return target === 'codex'
    ? inventory.installed.find(plugin => plugin.pluginId === pluginId && plugin.enabled)
    : inventory.find(plugin => plugin.id === pluginId && plugin.enabled !== false);
}

async function codexTrustStatus(root, registration, options) {
  const client = connectCodex({ cwd: root, ...options });
  try {
    await client.initialize();
    const inventory = await hookTrust(client, { project: root });
    const commands = registration?.commands ?? [];
    const hooks = inventory.hooks.filter(hook => registration
      ? samePath(hook.sourcePath, registration.source) && commands.includes(hook.command)
      : hook.pluginId === pluginId);
    if (registration && hooks.length !== commands.length) return false;
    return hooks.length > 0 && hooks.every(hook => hook.enabled && ['trusted', 'managed'].includes(hook.trustStatus));
  } finally {
    await client.close();
  }
}

async function github(path, signal = AbortSignal.timeout(8000)) {
  const response = await fetch(upstream + path, { signal });
  if (!response.ok) throw new Error(`Cannot check Geppetto upstream (HTTP ${response.status})`);
  return response.json();
}

const day = 86_400_000;

async function startupDiagnostic(root, home, epoch, phase) {
  const directory = resolve(home, '.geppetto');
  await mkdir(directory, { recursive: true });
  if (await claimFile(resolve(directory, 'update-' + phase + '-' + epoch + '.error'))) {
    await logHookEvent(root, { hook: 'updateCheck', status: 'error', phase, modelCalls: 0 });
  }
}

async function startupTrust(root, home, epoch, version, plugin, checkTrust) {
  const machine = await jsonFile(resolve(home, '.geppetto/machine.json'), {});
  const registration = machine.hooks?.codex;
  if (!plugin && !registration) return 'unknown';
  const key = createHash('sha256').update(JSON.stringify([root, version, plugin, registration])).digest('hex');
  const cache = resolve(home, '.geppetto', 'update-trust-' + key + '.json');
  const saved = await jsonFile(cache, {});
  if (saved.epoch === epoch) return saved.status;
  const lock = cache + '.' + epoch + '.lock';
  if (!await claimFile(lock)) return 'checking';
  try {
    const concurrent = await jsonFile(cache, {});
    if (concurrent.epoch === epoch) return concurrent.status;
    let status;
    try {
      status = await checkTrust(root, plugin || registration?.source === 'plugin' ? undefined : registration, { timeoutMs: 1000 })
        ? 'trusted' : 'approval required';
    } catch {
      status = 'unknown';
      await startupDiagnostic(root, home, epoch, 'trust');
    }
    await atomicJson(cache, { epoch, status });
    return status;
  } finally {
    await unlink(lock);
  }
}

async function latestVersion(signal) {
  const release = await github('/releases/latest', signal);
  const version = release.tag_name?.match(/^v(\d+\.\d+\.\d+)$/)?.[1];
  if (!version) throw new Error('Unexpected Geppetto release tag');
  return { version, tag: release.tag_name };
}

// Release tags and package manifests use three numeric components.
function olderVersion(installed, published) {
  if (!/^\d+\.\d+\.\d+$/.test(installed ?? '') || !/^\d+\.\d+\.\d+$/.test(published ?? '')) return false;
  const comparison = installed.split('.').map((part, i) => Number(part) - Number(published.split('.')[i]));
  return (comparison.find(difference => difference !== 0) ?? 0) < 0;
}

async function readUpdateNotice(root, { home = userHome(), now = Date.now, harness, checkTrust = codexTrustStatus } = {}) {
  const targets = harness === 'claude' ? ['claude'] : harness === 'antigravity' ? ['antigravity'] : harness === 'codex' ? ['codex', 'agents'] : ['claude', 'codex', 'agents', 'antigravity'];
  const local = await jsonFile(resolve(root, '.geppetto/install.json'), {});
  const user = root === home || !targets.some(name => local.installations?.[name]);
  const manifest = user ? await jsonFile(resolve(home, '.geppetto/install.json'), {}) : local;
  const target = targets.find(name => manifest.installations?.[name]);
  if (!target) return '';
  const epoch = Math.floor(now() / day);
  const cache = resolve(home, '.geppetto/update-status.json');
  const attempted = resolve(home, '.geppetto/update-attempt');
  let status;
  try { status = await jsonFile(cache, {}); }
  catch { await startupDiagnostic(root, home, epoch, 'cache'); status = {}; }
  if (status.epoch !== epoch && (await jsonFile(attempted, {})).epoch !== epoch) {
    await mkdir(dirname(cache), { recursive: true });
    const lock = resolve(home, '.geppetto', `update-attempt-${epoch}.lock`);
    if (await claimFile(lock, String(epoch))) {
      try {
        if ((await jsonFile(attempted, {})).epoch === epoch) return '';
        await atomicJson(attempted, { epoch });
        const signal = AbortSignal.timeout(2000);
        const release = await latestVersion(signal);
        status = { epoch, ...release, sha: await releaseCommit(release.tag, signal), scheduler: await schedulerSnapshot(home) };
        await atomicJson(cache, status);
      } catch {
        await startupDiagnostic(root, home, epoch, 'upstream');
      } finally {
        await unlink(lock);
      }
    }
  }
  if (status.epoch !== epoch) return '';
  const packageVersion = (await jsonFile(new URL('../../../package.json', import.meta.url), {})).version;
  const upgradeAvailable = olderVersion(packageVersion, status.version);
  // A cache from before installation cannot diagnose the current release's CI pin.
  const pinDrift = !user && !olderVersion(status.version, packageVersion) && await checkPin(root, status.sha, () => {});
  const maintenanceDrift = await machineDrift(user ? home : root, manifest.source, home, { log: () => {}, scheduler: status.scheduler ?? {} });
  const plugin = manifest.installations[target]?.plugin === true;
  const trust = !upgradeAvailable && (target === 'codex' || target === 'agents')
    ? await startupTrust(root, home, epoch, packageVersion, plugin, checkTrust) : 'trusted';
  const reasons = [olderVersion(manifest.source?.version, packageVersion) && 'adoption behind',
    pinDrift && 'project CI pin', maintenanceDrift && 'maintenance registration',
    !['trusted', 'checking'].includes(trust) && ('Codex hook trust: ' + trust)].filter(Boolean);
  if (!upgradeAvailable && !reasons.length) return '';
  const summary = upgradeAvailable ? 'Geppetto ' + status.version + ' is published.' : 'Geppetto installation needs repair (' + reasons.join(', ') + ').';
  return summary + ' Run node "' + installer + '" --check-update --target ' + target
    + (user ? ' --user' : ' --project "' + root + '"') + (plugin ? ' --plugin-hooks' : '') + ' before reconciling.';
}
export async function updateNotice(root, options) {
  try {
    return await readUpdateNotice(root, options);
  } catch {
    const { home = userHome(), now = Date.now } = options ?? {};
    try { await startupDiagnostic(root, home, Math.floor(now() / day), 'local'); }
    catch { console.error('Geppetto update notice failed to record its diagnostic.'); }
    return '';
  }
}

async function releaseCommit(tag, signal) {
  const { sha } = await github(`/commits/${tag}`, signal);
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('Unexpected Geppetto release commit');
  return sha;
}

async function checkPin(root, releaseSha, log = console.log) {
  const config = await jsonFile(resolve(root, '.geppetto/config.json'), {});
  if (config.ci?.enabled === false) return false;
  const workflow = await readFile(resolve(root, '.github/workflows/pr-gate.yml'), 'utf8')
    .catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const pin = workflow.match(/^\s*repository: immagiov4\/Geppetto\s*\r?\n\s*ref: ([0-9a-f]{40})\s*$/im)?.[1];
  const matches = Boolean(pin && pin === releaseSha);
  log(`Project CI pin: ${matches ? 'current' : 'missing or outdated'}`);
  return !matches;
}
async function schedulerSnapshot(home, machine, execute) {
  machine ??= await jsonFile(resolve(home, '.geppetto/machine.json'), {});
  return Object.fromEntries(maintenanceJobs.map(name => [name, maintenanceRegistrationStatus(name, machine.jobs?.[name], { home, execute })]));
}
async function machineDrift(root, source, home = userHome(), { log = console.log, scheduler, execute } = {}) {
  const local = await jsonFile(resolve(root, '.geppetto/config.json'), {});
  const machine = await jsonFile(resolve(home, '.geppetto/machine.json'), {});
  const launcherPath = resolve(home, '.geppetto/bin/maintenance-launcher.mjs');
  const launcher = await exists(launcherPath) ? await readFile(launcherPath, 'utf8') : '';
  const sources = new Set([source?.path, ...Object.values(machine.projects ?? {}).flatMap(targets => Object.values(targets))]);
  const wrapperMissing = process.platform === 'win32' && Object.values(machine.jobs ?? {}).some(job => job.scheduler === 'windows-task-scheduler' && job.status === 'scheduled') && !await exists(resolve(home, '.geppetto/maintenance.vbs'));
  if (wrapperMissing) log('Windows maintenance entry point: missing maintenance.vbs');
  const launcherCurrent = !wrapperMissing && [...sources].some(path => typeof path === 'string' &&
    launcher.replaceAll('\r\n', '\n') === maintenanceLauncherText(home, { path }).replaceAll('\r\n', '\n'));
  log(`Maintenance launcher: ${launcherCurrent ? 'registered source matches' : 'missing or linked to a different source'}`);

  const memory = await memoryConfiguration(root, home);
  const registryPath = memory?.localPath && resolve(memory.localPath, 'jobs.md');
  const registry = registryPath && await exists(registryPath) ? parseJobRegistry(await readFile(registryPath, 'utf8')) : [];
  const schedule = scheduler ?? await schedulerSnapshot(home, machine, execute);
  let drift = !launcherCurrent;
  for (const name of maintenanceJobs) {
    const job = machine.jobs?.[name];
    const owner = job?.status === 'scheduled-elsewhere' ? job.machine : hostname();
    const registered = !registryPath || registry.some(row => row.job === name && row.machine === owner && row.scheduler === job?.scheduler && row.cadence === job?.cadence);
    const schedulerMissing = ['missing', 'disabled', 'action differs', 'cadence differs'].includes(schedule[name]);
    const scheduled = ['scheduled', 'scheduled-elsewhere'].includes(job?.status) && registered && !schedulerMissing;
    if (schedulerMissing) log(`${name}: native registration ${schedule[name]}`);
    const disabled = !job || job.status === 'disabled' || job.status === 'scheduled-elsewhere';
    const antigravityOnly = Object.keys(machine.hooks ?? {}).length > 0 && Object.keys(machine.hooks).every(name => name === 'antigravity');
    const expectedUnscheduled = antigravityOnly && job?.status === 'needs-scheduler' && !job.scheduler;
    const healthy = local.maintenance?.enabled === false ? disabled : (scheduled || expectedUnscheduled);
    log(`${name}: ${job?.status ?? 'missing'}${registered ? '' : ' (registry entry missing or different)'}`);
    drift ||= !healthy;
  }
  return drift;
}
export async function checkUpdate({ root, target, user, manifest, plugin, shellQuote, execute, home = userHome() }) {
  const { version, tag } = await latestVersion();
  console.log(`Published Geppetto: ${version}`);

  const installedVersion = manifest.installations[target] ? manifest.source?.version : undefined;
  console.log(`Adoption (${target}): ${installedVersion ?? 'missing'}`);
  const bundled = await jsonFile(resolve(installer, '../../../../package.json'), {});
  if (olderVersion(version, bundled.version) || olderVersion(version, installedVersion)) {
    console.log('The published release is older than this installation. Recheck after the matching package is published.');
    return 0;
  }
  const commit = user ? null : await releaseCommit(tag);
  const pinDrift = !user && await checkPin(root, commit);
  const maintenanceDrift = installedVersion && await machineDrift(root, manifest.source, home, { execute });
  const drift = installedVersion !== version || pinDrift || maintenanceDrift;
  let installPlugin = false;
  let repairPlugin = false;
  let repairTrust = false;
  const harness = target === 'agents' ? 'codex' : target;
  if (plugin) {
    const installed = await installedPlugin(harness, root, home);
    console.log(`Plugin (${target}): ${installed?.version ?? 'missing or disabled'}`);
    installPlugin = !installed;
    repairPlugin = installed?.version !== version;
    if (harness === 'codex' && installed) {
      repairTrust = !await codexTrustStatus(root);
      console.log(`Codex hook trust: ${repairTrust ? 'approval required' : 'trusted'}`);
    }
  }
  if (!plugin && harness === 'codex' && installedVersion) {
    const machine = await jsonFile(resolve(userHome(), '.geppetto/machine.json'), {});
    const registration = machine.hooks?.codex;
    repairTrust = !registration || !await codexTrustStatus(root, registration.source === 'plugin' ? undefined : registration);
    console.log(`Codex hook trust: ${repairTrust ? 'approval required' : 'trusted'}`);
  }
  if (repairPlugin) {
    const [refresh, update] = pluginRepair[target === 'agents' ? 'codex' : target];
    console.log(refresh);
    console.log(target === 'claude' && installPlugin ? 'claude plugin install geppetto@geppetto' : update);
  }
  if (drift || repairPlugin || repairTrust) {
    const checkout = `geppetto-${version}`;
    const installPath = shellQuote(bundled.version === version ? installer : `${checkout}/skills/geppetto-adopt/scripts/install.mjs`);
    if (bundled.version !== version) console.log(`git clone --branch ${tag} https://github.com/immagiov4/Geppetto.git ${checkout}`);
    const scope = user ? '--user' : `--project ${shellQuote(root)}`;
    console.log(`Reconcile with: node ${installPath} --target ${target} ${scope}${plugin ? ' --plugin-hooks' : ''}${user ? '' : ` --gate-sha ${commit}`}`);
  }
  return 0;
}
