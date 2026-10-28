import { readFile, writeFile, open, mkdir, readdir, access } from 'node:fs/promises';
import { resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, isMain, userHome, jsonFile, run } from './common.mjs';
import { learningCommand, executeLearning } from './learn-runner.mjs';
import { memorySettings } from './memory-config.mjs';
export const maintenanceJobs = ['curate-skills', 'maintain-memory'];
const cadence = 'weekly Monday 09:00 (local time)';
const cronCadence = '0 9 * * 1';
const psQuote = text => `'${text.replaceAll("'", "''")}'`;
const shQuote = text => `'${text.replaceAll("'", "'\\''")}'`;
/** Resolve disposable version directories while preserving source checkouts. */
async function maintenanceSource(source) {
  if (!/^\d+\.\d+\.\d+$/.test(basename(source))) return source;
  const cache = dirname(source), versions = await readdir(cache).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const version of versions.filter(name => /^\d+\.\d+\.\d+$/.test(name)).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))) {
    const candidate = resolve(cache, version);
    try {
      const metadata = JSON.parse(await readFile(resolve(candidate, 'package.json'), 'utf8'));
      if (metadata.name !== 'geppetto' || metadata.version !== version) continue;
      await access(resolve(candidate, 'skills/geppetto-adopt/scripts/maintenance.mjs'));
      await access(resolve(candidate, 'skills/geppetto-adopt/scripts/common.mjs'));
      return candidate;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('No installed Geppetto maintenance package in ' + cache + '; reinstall the plugin.');
}
/** Refresh the fixed OS entrypoint while the installer holds the machine lock. */
export async function refreshMaintenanceLauncher(home, source) {
  const script = resolve(home, '.geppetto/bin/maintenance-launcher.mjs');
  await mkdir(resolve(home, '.geppetto/bin'), { recursive: true });
  // Embed the resolver so deleting its original plugin cache cannot break this entrypoint.
  await writeFile(script, `import { readdir, readFile, access } from 'node:fs/promises';
import { resolve, basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
${maintenanceSource.toString()}
try {
  const scripts = resolve(await maintenanceSource(${JSON.stringify(source.path)}), 'skills/geppetto-adopt/scripts');
  const { main } = await import(pathToFileURL(resolve(scripts, 'maintenance.mjs')).href);
  process.exitCode = (await main(process.argv.slice(2))) ?? 0;
} catch (error) { console.error(error.message); process.exitCode = 1; }
`);
  return script;
}
function nextWeeklyRun(expression) {
  const match = /^(\d+) (\d+) \* \* ([0-6])$/.exec(expression);
  if (!match || Number(match[1]) > 59 || Number(match[2]) > 23) throw new Error('Inspect the existing cron cadence and register it through --scheduler-jobs with its next run.');
  const now = new Date(), next = new Date(now);
  next.setHours(Number(match[2]), Number(match[1]), 0, 0);
  next.setDate(next.getDate() + (Number(match[3]) - next.getDay() + 7) % 7);
  if (next <= now) next.setDate(next.getDate() + 7);
  return next.toISOString();
}
/** Inspect or attach one OS job; native harness jobs are supplied by adoption first. */
export async function scheduleMaintenance(name, { home = userHome(), host, source, platform = process.platform, execute = run, command = learningCommand(host) }) {
  if (!maintenanceJobs.includes(name)) throw new Error('Unknown maintenance job');
  const script = await refreshMaintenanceLauncher(home, source);
  const id = `Geppetto-${name}`;
  if (platform === 'win32') {
    const available = execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Command Register-ScheduledTask -ErrorAction Stop | Out-Null']);
    if (available.error?.code === 'ENOENT') return null;
    if (available.status !== 0) throw new Error('Windows Task Scheduler is unavailable; inspect PowerShell ScheduledTasks support.');
    if (!command) throw new Error(`Install ${host} CLI and sign in before attaching maintenance.`);
    const launcher = resolve(home, '.geppetto/maintenance.vbs');
    await mkdir(resolve(home, '.geppetto'), { recursive: true });
    const action = `"${process.execPath}" "${script}" --run `;
    await writeFile(launcher, `WScript.Quit CreateObject("WScript.Shell").Run("${action.replaceAll('"', '""')}" & WScript.Arguments(0), 0, True)\n`);
    const args = `"${launcher}" ${name}`;
    const code = `$ErrorActionPreference='Stop'; $id=${psQuote(id)}; $task=Get-ScheduledTask -TaskName $id -ErrorAction SilentlyContinue; if ($task) { if ($task.Actions.Execute -ne 'wscript.exe' -or $task.Actions.Arguments -ne ${psQuote(args)}) { throw 'Existing task has a different action; reconcile it before adoption' } } else { $action=New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ${psQuote(args)}; $trigger=New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At '09:00'; $settings=New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable; $task=Register-ScheduledTask -TaskName $id -Action $action -Trigger $trigger -Settings $settings }; $info=Get-ScheduledTaskInfo -TaskName $id; @{id=$id;nextRun=$info.NextRunTime.ToString('o')} | ConvertTo-Json -Compress`;
    const result = execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')]);
    if (result.status !== 0) throw new Error(`Windows maintenance registration failed: ${result.stderr?.trim() || result.error?.message}`);
    const registered = JSON.parse(result.stdout);
    return { ...registered, scheduler: 'windows-task-scheduler', cadence, disable: `schtasks.exe /Change /TN ${id} /DISABLE`, status: 'scheduled', host };
  }
  const listed = execute('crontab', ['-l']);
  if (listed.error?.code === 'ENOENT') return null;
  if (listed.status !== 0 && !/no crontab/i.test(listed.stderr ?? '')) throw new Error(`Cannot inspect crontab: ${listed.stderr?.trim()}`);
  if (!command) throw new Error(`Install ${host} CLI and sign in before attaching maintenance.`);
  const marker = `# ${id}`;
  const existing = (listed.stdout ?? '').split('\n').find(line => line.endsWith(marker));
  const invocation = `${shQuote(process.execPath)} ${shQuote(script)} --run ${name}`;
  const expression = existing?.trim().split(/\s+/).slice(0, 5).join(' ') || cronCadence;
  const nextRun = nextWeeklyRun(expression);
  const entry = `${expression} ${invocation} ${marker}`;
  const lines = (listed.stdout ?? '').split('\n');
  const owned = lines.filter(line => line.endsWith(marker));
  if (owned.length !== 1 || existing !== entry) {
    const kept = lines.filter(line => !line.endsWith(marker)).join('\n');
    const result = execute('crontab', ['-'], { input: `${kept}${kept.endsWith('\n') ? '' : '\n'}${entry}\n` });
    if (result.status !== 0) throw new Error(`Maintenance crontab registration failed: ${result.stderr?.trim()}`);
  }
  return { scheduler: 'cron', id, cadence: expression, nextRun, disable: `crontab -e (remove ${marker})`, status: 'scheduled', host };
}
/** Remove only the known OS registration; external schedulers need confirmation from adoption. */
export async function disableMaintenance(name, job, { execute = run } = {}) {
  if (job.status === 'disabled') return true;
  if (job.scheduler === 'windows-task-scheduler') {
    if (job.id !== `Geppetto-${name}`) throw new Error('Reconcile the maintenance task identity before disabling it.');
    const result = execute('schtasks.exe', ['/Change', '/TN', job.id, '/DISABLE']);
    if (result.status !== 0) throw new Error(`Cannot disable maintenance task: ${result.stderr?.trim() || result.error?.message}`);
    return true;
  }
  if (job.scheduler === 'cron') {
    const listed = execute('crontab', ['-l']);
    if (listed.status !== 0 && !/no crontab/i.test(listed.stderr ?? '')) throw new Error('Cannot inspect maintenance crontab for removal.');
    const text = listed.stdout ?? '';
    const kept = text.split('\n').filter(line => !line.endsWith(`# Geppetto-${name}`)).join('\n');
    if (kept !== text && execute('crontab', ['-'], { input: kept }).status !== 0) throw new Error('Cannot remove maintenance crontab entry.');
    return true;
  }
  return false;
}
/** Run only active registrations with the subscription CLI, inheriting its model settings. */
export async function main(args) {
  if (![2, 3].includes(args.length) || args[0] !== '--run' || !maintenanceJobs.includes(args[1]) || (args.length === 3 && args[2] !== '--dry-run')) throw new Error('Usage: maintenance.mjs --run <curate-skills|maintain-memory> [--dry-run]');
  const machine = await jsonFile(resolve(userHome(), '.geppetto/machine.json'));
  const job = machine.jobs[args[1]];
  if (job?.status !== 'scheduled') return 0;
  for (const targets of Object.values(machine.projects ?? {})) for (const [target, source] of Object.entries(targets)) targets[target] = await maintenanceSource(source);
  const memory = args[1] === 'maintain-memory' ? await memorySettings(userHome()) : null;
  const procedure = new URL(`../../${args[1] === 'maintain-memory' ? 'geppetto-memory' : 'skill-learning-patterns'}/SKILL.md`, import.meta.url);
  const source = new URL(`../assets/templates/jobs/${args[1]}.md`, import.meta.url);
  const prompt = `${await readFile(procedure, 'utf8')}\n${await readFile(source, 'utf8')}\nResolved machine context: ${JSON.stringify({ projects: machine.projects, memory: memory ?? machine.memory })}. Work only within the supplied file tools; private buckets are excluded. Keep changes local for review.\n`;
  const roots = args[1] === 'maintain-memory' ? [memory?.localPath ?? machine.memory?.localPath].filter(Boolean) : [...new Set(Object.values(machine.projects).flatMap(project => Object.values(project)))];
  if (args[2] === '--dry-run') { console.log(JSON.stringify({ job: args[1], host: job.host ?? 'codex', source: fileURLToPath(source), roots })); return 0; }
  const log = resolve(userHome(), `.geppetto/${args[1]}.log`);
  await writeFile(log, roots.length ? '' : 'No configured maintenance destination.\n');
  const output = await open(log, 'a');
  try {
    for (const cwd of roots) {
      await output.write(`${cwd}\n`);
      await executeLearning({ cwd, prompt, host: job.host ?? 'codex', output: output.fd });
    }
  } finally { await output.close(); }
  return 0;
}
if (isMain(import.meta.url)) await cli(main);
