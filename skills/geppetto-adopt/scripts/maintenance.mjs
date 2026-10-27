import { readFile, writeFile, open, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cli, isMain, userHome, jsonFile, run } from './common.mjs';
import { learningCommand, executeLearning } from './learn-runner.mjs';
import { memorySettings } from './memory-config.mjs';

export const maintenanceJobs = ['curate-skills', 'maintain-memory'];
const cadence = 'weekly Monday 09:00 (local time)';
const cronCadence = '0 9 * * 1';
const psQuote = text => `'${text.replaceAll("'", "''")}'`;
const shQuote = text => `'${text.replaceAll("'", "'\\''")}'`;

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
  const script = resolve(source.path, 'skills/geppetto-adopt/scripts/maintenance.mjs');
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
    const code = `$ErrorActionPreference='Stop'; $id=${psQuote(id)}; $task=Get-ScheduledTask -TaskName $id -ErrorAction SilentlyContinue; if ($task) { if ($task.Actions.Execute -ne 'wscript.exe' -or $task.Actions.Arguments -ne ${psQuote(args)}) { throw 'Existing task has a different action; reconcile it before adoption' } } else { $action=New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ${psQuote(args)}; $trigger=New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At '09:00'; $settings=New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable; $task=Register-ScheduledTask -TaskName $id -Action $action -Trigger $trigger -Settings $settings }; $info=Get-ScheduledTaskInfo -TaskName $id; @{id=$id;cadence=($task.Triggers | ConvertTo-Json -Compress);nextRun=$info.NextRunTime.ToString('o')} | ConvertTo-Json -Compress`;
    const result = execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')]);
    if (result.status !== 0) throw new Error(`Windows maintenance registration failed: ${result.stderr?.trim() || result.error?.message}`);
    const registered = JSON.parse(result.stdout);
    return { ...registered, scheduler: 'windows-task-scheduler', cadence: registered.cadence || cadence, disable: `schtasks.exe /Change /TN ${id} /DISABLE`, status: 'scheduled', host };
  }
  const listed = execute('crontab', ['-l']);
  if (listed.error?.code === 'ENOENT') return null;
  if (listed.status !== 0 && !/no crontab/i.test(listed.stderr ?? '')) throw new Error(`Cannot inspect crontab: ${listed.stderr?.trim()}`);
  if (!command) throw new Error(`Install ${host} CLI and sign in before attaching maintenance.`);
  const marker = `# ${id}`;
  const existing = (listed.stdout ?? '').split('\n').find(line => line.endsWith(marker));
  const invocation = `${shQuote(process.execPath)} ${shQuote(script)} --run ${name}`;
  if (existing && !existing.includes(invocation)) throw new Error(`${id}: existing cron action needs reconciliation`);
  const expression = existing?.slice(0, existing.indexOf(invocation)).trim() || cronCadence;
  const nextRun = nextWeeklyRun(expression);
  if (!existing) {
    const result = execute('crontab', ['-'], { input: `${listed.stdout ?? ''}\n${cronCadence} ${invocation} ${marker}\n` });
    if (result.status !== 0) throw new Error(`Maintenance crontab registration failed: ${result.stderr?.trim()}`);
  }
  return { scheduler: 'cron', id, cadence: expression, nextRun, disable: `crontab -e (remove ${marker})`, status: 'scheduled', host };
}

/** Run the registered prompt with the subscription CLI, inheriting its model settings. */
export async function main(args) {
  if (args.length !== 2 || args[0] !== '--run' || !maintenanceJobs.includes(args[1])) throw new Error('Usage: maintenance.mjs --run <curate-skills|maintain-memory>');
  const machine = await jsonFile(resolve(userHome(), '.geppetto/machine.json'));
  const job = machine.jobs[args[1]];
  const memory = args[1] === 'maintain-memory' ? await memorySettings(userHome()) : null;
  const procedure = new URL(`../../${args[1] === 'maintain-memory' ? 'geppetto-memory' : 'skill-learning-patterns'}/SKILL.md`, import.meta.url);
  const prompt = `${await readFile(procedure, 'utf8')}\n${await readFile(job.source, 'utf8')}\nResolved machine context: ${JSON.stringify({ projects: machine.projects, memory: memory ?? machine.memory })}. Work only within the supplied file tools; private buckets are excluded. Keep changes local for review.\n`;
  const roots = args[1] === 'maintain-memory' ? [memory?.localPath ?? machine.memory?.localPath].filter(Boolean) : [...new Set(Object.values(machine.projects).flatMap(project => Object.values(project)))];
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
