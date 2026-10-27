import { readFile, mkdir, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { jsonFile, atomicJson, userHome, defaultConfig, exists } from './common.mjs';
import { memorySettings } from './memory-config.mjs';
import { scheduleMaintenance, maintenanceJobs } from './maintenance.mjs';

/** Reuse machine resources; hook commands point to the recorded package source. */
export async function reconcileMachine(project, target, source, { pluginHooks = false, uninstall = false, home = userHome(), jobs = {}, scheduler = scheduleMaintenance } = {}) {
  for (const [name, job] of Object.entries(jobs)) if (!maintenanceJobs.includes(name) || ['id', 'scheduler', 'cadence', 'nextRun', 'disable'].some(key => typeof job?.[key] !== 'string' || !job[key].trim())) throw new Error('Scheduler registrations need name, id, scheduler, cadence, nextRun and disable command');
  const directory = resolve(home, '.geppetto');
  await mkdir(directory, { recursive: true });
  const lockPath = resolve(directory, 'machine.lock'); const lock = await open(lockPath, 'wx', 0o600);
  try {
    const path = resolve(directory, 'machine.json'); const machine = await jsonFile(path, { projects: {}, hooks: {}, jobs: {}, keys: {} });
    const harness = target === 'claude' ? 'claude' : 'codex';
    if (uninstall) {
      if (machine.projects[project]) { delete machine.projects[project][target]; if (!Object.keys(machine.projects[project]).length) delete machine.projects[project]; }
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
    const user = await jsonFile(resolve(directory, 'config.json'), {});
    const configPath = resolve(project, '.geppetto/config.json');
    const local = await jsonFile(configPath, defaultConfig());
    if (!await exists(configPath)) await atomicJson(configPath, local);
    machine.projects[project] = { ...machine.projects[project], [target]: source.path };
    if (process.env.OPENROUTER_API_KEY) machine.keys.openrouter ??= 'OPENROUTER_API_KEY';
    if (user.memory?.repo || user.memory?.localPath) machine.memory = user.memory;
    else {
      const memory = await memorySettings(project, home);
      if (!machine.memory && (memory?.repo || memory?.localPath)) machine.memory = Object.fromEntries(['repo', 'localPath'].filter(key => memory[key]).map(key => [key, memory[key]]));
      if (machine.memory) { user.memory = { ...user.memory, ...machine.memory }; await atomicJson(resolve(directory, 'config.json'), user); }
    }
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
    for (const name of maintenanceJobs) {
      if (machine.jobs[name]?.status === 'scheduled') continue;
      const attached = jobs[name] ?? await scheduler(name, { home, host: harness, source });
      machine.jobs[name] = { source: resolve(source.path, `skills/geppetto-adopt/assets/templates/jobs/${name}.md`), ...attached, status: attached ? 'scheduled' : 'needs-scheduler' };
      await atomicJson(path, machine);
    }
    await atomicJson(path, machine);
    return machine;
  } finally { await lock.close(); await unlink(lockPath); }
}
