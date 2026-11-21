import { mkdir, readFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson, claimFile, exists, jsonFile, run, userHome } from './common.mjs';
import { connectCodex, hookTrust, samePath } from './codex-hook-trust.mjs';
import { maintenanceJobs, maintenanceLauncherText } from './maintenance.mjs';
import { memoryConfiguration } from './memory-config.mjs';
import { parseJobRegistry } from './memory-jobs.mjs';
import { learningCommand } from './learn-runner.mjs';

const upstream = 'https://api.github.com/repos/immagiov4/Geppetto';
const pluginId = 'geppetto@geppetto';
const pluginRepair = {
  claude: ['claude plugin marketplace update geppetto', 'claude plugin update geppetto@geppetto'],
  codex: ['codex plugin marketplace upgrade geppetto', 'codex plugin add geppetto@geppetto'],
};
const installer = fileURLToPath(new URL('./install.mjs', import.meta.url));

function installedPlugin(target, root) {
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

async function codexTrustStatus(root, registration) {
  const client = connectCodex({ cwd: root });
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

async function latestVersion(signal) {
  const release = await github('/releases/latest', signal);
  const version = release.tag_name?.match(/^v(\d+\.\d+\.\d+)$/)?.[1];
  if (!version) throw new Error('Unexpected Geppetto release tag');
  return { version, tag: release.tag_name };
}

async function readUpdateNotice(root, { home = userHome(), now = Date.now } = {}) {
  const local = await jsonFile(resolve(root, '.geppetto/install.json'), {});
  const user = !Object.keys(local.installations ?? {}).length;
  const manifest = user ? await jsonFile(resolve(home, '.geppetto/install.json'), {}) : local;
  const target = ['claude', 'codex', 'agents'].find(name => manifest.installations?.[name]);
  if (!target) return '';
  const epoch = Math.floor(now() / day);
  const cache = resolve(home, '.geppetto/update-status.json');
  const attempted = resolve(home, '.geppetto/update-attempt');
  let status = await jsonFile(cache, {});
  if (status.epoch !== epoch && (await jsonFile(attempted, {})).epoch !== epoch) {
    await mkdir(dirname(cache), { recursive: true });
    const lock = resolve(home, '.geppetto', `update-attempt-${epoch}.lock`);
    if (await claimFile(lock, String(epoch))) {
      try {
        if ((await jsonFile(attempted, {})).epoch === epoch) return '';
        await atomicJson(attempted, { epoch });
        const signal = AbortSignal.timeout(2000);
        const release = await latestVersion(signal);
        status = { epoch, ...release, sha: await releaseCommit(release.tag, signal) };
        await atomicJson(cache, status);
      } catch {
        // The explicit checker surfaces upstream errors. A startup failure is retried tomorrow.
      } finally {
        await unlink(lock);
      }
    }
  }
  if (status.epoch !== epoch) return '';
  const packageVersion = (await jsonFile(new URL('../../../package.json', import.meta.url), {})).version;
  const pinDrift = !user && await checkPin(root, status.sha, () => {});
  const maintenanceDrift = await machineDrift(user ? home : root, manifest.source, home, { log: () => {}, inspectScheduler: false });
  if (status.version === packageVersion && status.version === manifest.source?.version && !pinDrift && !maintenanceDrift) return '';
  return `Geppetto ${status.version} is published. Run node "${installer}" --check-update --target ${target} ${user ? '--user' : `--project "${root}"`} before reconciling.`;
}
export async function updateNotice(root, options) {
  try {
    return await readUpdateNotice(root, options);
  } catch {
    // Optional update state must not prevent other SessionStart notices.
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
function localJobPresent(name, job) {
  const id = `Geppetto-${name}`;
  if (job.scheduler === 'windows-task-scheduler') {
    const query = run('schtasks.exe', ['/Query', '/TN', id, '/XML']);
    return query.status === 0 && !/<Enabled>false<\/Enabled>/i.test(query.stdout);
  }
  if (job.scheduler === 'cron') {
    const list = run('crontab', ['-l']);
    return list.status === 0 && list.stdout.split(/\r?\n/).some(line => !line.trimStart().startsWith('#') && line.endsWith(`# ${id}`));
  }
  return Boolean(job.id);
}

async function machineDrift(root, source, home = userHome(), { log = console.log, inspectScheduler = true } = {}) {
  const local = await jsonFile(resolve(root, '.geppetto/config.json'), {});
  const machine = await jsonFile(resolve(home, '.geppetto/machine.json'), {});
  const launcherPath = resolve(home, '.geppetto/bin/maintenance-launcher.mjs');
  const launcher = await exists(launcherPath) ? await readFile(launcherPath, 'utf8') : '';
  const sources = new Set([source?.path, ...Object.values(machine.projects ?? {}).flatMap(targets => Object.values(targets))]);
  const launcherCurrent = [...sources].some(path => typeof path === 'string' &&
    launcher.replaceAll('\r\n', '\n') === maintenanceLauncherText(home, { path }).replaceAll('\r\n', '\n'));
  log(`Maintenance launcher: ${launcherCurrent ? 'registered source matches' : 'missing or linked to a different source'}`);

  const memory = await memoryConfiguration(root, home);
  const registryPath = memory?.localPath && resolve(memory.localPath, 'jobs.md');
  const registry = registryPath && await exists(registryPath) ? parseJobRegistry(await readFile(registryPath, 'utf8')) : [];
  let drift = !launcherCurrent;
  for (const name of maintenanceJobs) {
    const job = machine.jobs?.[name];
    const owner = job?.status === 'scheduled-elsewhere' ? job.machine : hostname();
    const registered = !registryPath || registry.some(row => row.job === name && row.machine === owner && row.scheduler === job?.scheduler && row.cadence === job?.cadence);
    const schedulerMissing = inspectScheduler && job?.status === 'scheduled' && !localJobPresent(name, job);
    const scheduled = ['scheduled', 'scheduled-elsewhere'].includes(job?.status) && registered && !schedulerMissing;
    if (schedulerMissing) log(`${name}: native registration missing or disabled`);
    const disabled = !job || job.status === 'disabled' || job.status === 'scheduled-elsewhere';
    const healthy = local.maintenance?.enabled === false ? disabled : scheduled;
    log(`${name}: ${job?.status ?? 'missing'}${registered ? '' : ' (registry entry missing or different)'}`);
    drift ||= !healthy;
  }
  return drift;
}
export async function checkUpdate({ root, target, user, manifest, plugin, shellQuote }) {
  const { version, tag } = await latestVersion();
  console.log(`Published Geppetto: ${version}`);

  const installedVersion = manifest.installations[target] ? manifest.source?.version : undefined;
  console.log(`Adoption (${target}): ${installedVersion ?? 'missing'}`);
  const commit = user ? null : await releaseCommit(tag);
  const pinDrift = !user && await checkPin(root, commit);
  const maintenanceDrift = installedVersion && await machineDrift(root, manifest.source);
  const drift = installedVersion !== version || pinDrift || maintenanceDrift;
  let installPlugin = false;
  let repairPlugin = false;
  let repairTrust = false;
  const harness = target === 'agents' ? 'codex' : target;
  if (plugin) {
    const installed = installedPlugin(harness, root);
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
    const bundled = await jsonFile(resolve(installer, '../../../../package.json'), {});
    const checkout = `geppetto-${version}`;
    const installPath = shellQuote(bundled.version === version ? installer : `${checkout}/skills/geppetto-adopt/scripts/install.mjs`);
    if (bundled.version !== version) console.log(`git clone --branch ${tag} https://github.com/immagiov4/Geppetto.git ${checkout}`);
    const scope = user ? '--user' : `--project ${shellQuote(root)}`;
    console.log(`Reconcile with: node ${installPath} --target ${target} ${scope}${plugin ? ' --plugin-hooks' : ''}${user ? '' : ` --gate-sha ${commit}`}`);
  }
  return 0;
}
