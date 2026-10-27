import { readFile, mkdir, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hostname } from 'node:os';
import { jsonFile, atomicJson, userHome, defaultConfig, exists, run } from './common.mjs';
import { memorySettings } from './memory-config.mjs';
import { setupMemory, bridgeNativeMemory } from './memory-setup.mjs';
import { memoryJobs } from './memory-jobs.mjs';
import { scheduleMaintenance, disableMaintenance, maintenanceJobs, refreshMaintenanceLauncher } from './maintenance.mjs';

async function stopJobs(machine, path, jobs, unscheduler, execute) {
  for (const name of maintenanceJobs) {
    const previous = machine.jobs[name];
    if (!['scheduled', 'needs-disable', 'starting'].includes(previous?.status)) continue;
    const confirmation = jobs[name];
    if (confirmation?.status === 'disabled' && ((previous.id && confirmation.id !== previous.id) || (previous.scheduler && confirmation.scheduler !== previous.scheduler))) throw new Error('Disabled job confirmation must match the registered scheduler and id.');
    machine.jobs[name] = { ...previous, status: 'needs-disable' };
    await atomicJson(path, machine);
    if (!await unscheduler(name, confirmation?.status === 'disabled' ? confirmation : previous, { execute })) throw new Error(`Disable ${name} in ${previous.scheduler}, then retry with its disabled confirmation through --scheduler-jobs.`);
    machine.jobs[name].status = 'disabled';
    await atomicJson(path, machine);
  }
}

async function attachJobs(machine, path, registry, { home, harness, source, jobs, scheduler, addJobs, machineName }) {
  const previousJobs = { ...machine.jobs };
  const claim = rows => maintenanceJobs.map(name => {
    const own = rows.find(row => row.job === name && row.machine === machineName);
    const owner = own ?? rows.find(row => row.job === name);
    if (owner && owner.machine !== machineName && !addJobs.includes(name) && previousJobs[name]?.status !== 'scheduled') return { name, elsewhere: { ...owner } };
    const row = { machine: machineName, job: name, scheduler: own?.scheduler ?? 'pending', cadence: own?.cadence ?? 'pending', registered: own?.registered ?? new Date().toISOString() };
    if (own) Object.assign(own, row); else rows.push(row);
    return { name };
  });
  // Claim the whole installation before the first scheduler can activate either job.
  const decisions = registry ? await registry.update(claim) : maintenanceJobs.map(name => ({ name }));
  for (const { name, elsewhere } of decisions) {
    if (elsewhere) {
      machine.jobs[name] = { ...elsewhere, status: elsewhere.scheduler === 'pending' ? 'pending-elsewhere' : 'scheduled-elsewhere' };
      await atomicJson(path, machine); continue;
    }
    const previous = previousJobs[name];
    machine.jobs[name] = { ...previous, status: 'starting' };
    await atomicJson(path, machine);
    const osJob = ['windows-task-scheduler', 'cron'].includes(previous?.scheduler);
    const attached = previous?.status === 'scheduled' && !osJob ? previous : jobs[name] ?? await scheduler(name, { home, host: previous?.host ?? harness, source });
    machine.jobs[name] = { ...attached, source: resolve(source.path, `skills/geppetto-adopt/assets/templates/jobs/${name}.md`), status: attached ? 'scheduled' : 'needs-scheduler' };
    await atomicJson(path, machine);
    if (registry) await registry.update(rows => {
      const index = rows.findIndex(row => row.machine === machineName && row.job === name);
      if (!attached) { if (index !== -1) rows.splice(index, 1); return; }
      const row = { machine: machineName, job: name, scheduler: attached.scheduler, cadence: attached.cadence, registered: index === -1 ? new Date().toISOString() : rows[index].registered };
      if (index === -1) rows.push(row); else rows[index] = row;
    });
  }
}

/** Reuse machine resources; hook commands point to the recorded package source. */
export async function reconcileMachine(project, target, source, { pluginHooks = false, uninstall = false, home = userHome(), jobs = {}, scheduler = scheduleMaintenance, unscheduler = disableMaintenance, memoryChoice, addJobs = [], machineName = hostname(), execute = run, uninstallMemory } = {}) {
  for (const [name, job] of Object.entries(jobs)) if (!maintenanceJobs.includes(name) || ['id', 'scheduler', 'cadence', 'nextRun', 'disable'].some(key => typeof job?.[key] !== 'string' || !job[key].trim())) throw new Error('Scheduler registrations need name, id, scheduler, cadence, nextRun and disable command');
  const directory = resolve(home, '.geppetto');
  await mkdir(directory, { recursive: true });
  const lockPath = resolve(directory, 'machine.lock'); const lock = await open(lockPath, 'wx', 0o600);
  try {
    const path = resolve(directory, 'machine.json'); const machine = await jsonFile(path, { projects: {}, hooks: {}, jobs: {}, keys: {} });
    const harness = target === 'claude' ? 'claude' : 'codex';
    if (uninstall) {
      if (!machine.projects[project]?.[target]) return machine;
      const remaining = Object.entries(machine.projects).some(([root, targets]) => root !== project || Object.keys(targets).some(name => name !== target));
      if (!remaining) {
        await stopJobs(machine, path, jobs, unscheduler, execute);
        const memory = uninstallMemory === undefined ? await memorySettings(project, home) ?? machine.memory : uninstallMemory;
        const registry = await memoryJobs(memory, execute);
        if (registry) await registry.update(rows => { rows.splice(0, rows.length, ...rows.filter(row => row.machine !== machineName)); });
        delete machine.memory;
      }
      delete machine.projects[project][target];
      if (!Object.keys(machine.projects[project]).length) { delete machine.projects[project]; await bridgeNativeMemory(project, machine, null); }
      if (!Object.values(machine.projects).some(project => harness === 'claude' ? project.claude : project.codex || project.agents)) {
        const installed = machine.hooks[harness];
        if (installed?.commands) {
          const settings = await jsonFile(installed.source, {});
          for (const [event, groups] of Object.entries(settings.hooks ?? {})) settings.hooks[event] = groups.map(group => ({ ...group, hooks: group.hooks.filter(hook => !installed.commands.includes(hook.command)) })).filter(group => group.hooks.length);
          await atomicJson(installed.source, settings);
        }
        delete machine.hooks[harness];
      }
      await atomicJson(path, machine); return machine;
    }
    const configPath = resolve(project, '.geppetto/config.json');
    const local = await jsonFile(configPath, defaultConfig());
    if (!await exists(configPath)) await atomicJson(configPath, local);
    machine.projects[project] = { ...machine.projects[project], [target]: source.path };
    if (process.env.OPENROUTER_API_KEY) machine.keys.openrouter ??= 'OPENROUTER_API_KEY';
    const memory = await setupMemory(project, machine, { home, memoryChoice, execute });
    await bridgeNativeMemory(project, machine, memory);
    await atomicJson(path, machine);
    const registry = await memoryJobs(memory, execute);
    const hooksPath = resolve(home, harness === 'claude' ? '.claude/settings.json' : '.codex/hooks.json');
    if (pluginHooks) {
      const installed = machine.hooks[harness];
      if (installed?.commands) {
        const settings = await jsonFile(hooksPath, {});
        for (const [event, groups] of Object.entries(settings.hooks ?? {})) settings.hooks[event] = groups.map(group => ({ ...group, hooks: group.hooks.filter(hook => !installed.commands.includes(hook.command)) })).filter(group => group.hooks.length);
        await atomicJson(hooksPath, settings);
      }
      machine.hooks[harness] = { source: 'plugin' };
    }
    else if (machine.hooks[harness]?.source !== 'plugin') {
      const settings = await jsonFile(hooksPath, {});
      const template = JSON.parse(await readFile(resolve(source.path, 'hooks/hooks.json'), 'utf8'));
      settings.hooks ??= {};
      for (const [event, groups] of Object.entries(template.hooks)) {
        const kept = (settings.hooks[event] ?? []).map(group => ({ ...group, hooks: group.hooks.filter(hook => !machine.hooks[harness]?.commands?.includes(hook.command) && !/geppetto[^"\n]*[/\\](?:scripts|bin)[/\\]/i.test(hook.command ?? '')) })).filter(group => group.hooks.length);
        const installed = groups.map(group => ({ ...group, hooks: group.hooks.map(hook => ({ ...hook, command: hook.command.replaceAll('${CLAUDE_PLUGIN_ROOT}', source.path.replaceAll('\\', '/')) })) }));
        settings.hooks[event] = [...kept, ...installed];
      }
      await atomicJson(hooksPath, settings);
      machine.hooks[harness] = { source: hooksPath, commands: Object.values(template.hooks).flatMap(groups => groups.flatMap(group => group.hooks.map(hook => hook.command.replaceAll('${CLAUDE_PLUGIN_ROOT}', source.path.replaceAll('\\', '/'))))) };
    }
    machine.jobs.learn = { source: resolve(source.path, 'skills/geppetto-adopt/assets/templates/jobs/learn.md'), trigger: 'Stop', status: 'installed' };
    await refreshMaintenanceLauncher(home, source);
    await attachJobs(machine, path, registry, { home, harness, source, jobs, scheduler, addJobs, machineName });
    await atomicJson(path, machine);
    return machine;
  } finally { await lock.close(); await unlink(lockPath); }
}
