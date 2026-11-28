import { boundedMetricsAudit } from './metrics-audit.mjs';
import { newWeeklyDraft, disposeWeeklyDraft, publishWeeklyReport, weeklyWindowMs } from './weekly-report.mjs';

import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { readFile, writeFile, open, mkdir, readdir, access, rename, link, unlink, realpath } from 'node:fs/promises';
import { resolve, basename, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, isMain, userHome, jsonFile, run, exists, filesUnder, rejectSymlinks, foundationReport } from './common.mjs';
import { learningCommand, executeLearning } from './learn-runner.mjs';
import { credentialAssignment, redact } from './signal.mjs';
import { memorySettings } from './memory-config.mjs';
import { maintainMemory } from './memory-maintenance.mjs';
export const maintenanceJobs = ['curate-skills', 'maintain-memory'];
const maintenanceWrapper = home => resolve(home, '.geppetto/maintenance.vbs');
const windowsAction = 'wscript.exe';
const windowsJobArguments = (home, name) => '"' + maintenanceWrapper(home) + '" ' + name;
const windowsDay = 'Monday';
const windowsTime = '09:00';
const maintenanceLauncher = home => resolve(home, '.geppetto/bin/maintenance-launcher.mjs');
const cronInvocation = (home, name) => shQuote(process.execPath) + ' ' + shQuote(maintenanceLauncher(home)) + ' --run ' + name;
const xmlEntities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function maintenanceRegistrationStatus(name, job, { home = userHome(), execute = run } = {}) {
  if (job?.status !== 'scheduled') return null;
  const id = 'Geppetto-' + name;
  if (job.scheduler === 'windows-task-scheduler') {
    const query = execute('schtasks.exe', ['/Query', '/TN', id, '/XML'], { timeout: 2000 });
    if (query.status !== 0) return 'missing';
    const xml = query.stdout ?? '';
    const disabled = /<Enabled>false<\/Enabled>/i.test(xml);
    const elements = (input, tag) => Array.from(input.matchAll(new RegExp('<' + tag + '\\b[^>]*>([^]*?)</' + tag + '>', 'gi')),
      match => match[1].trim().replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => xmlEntities[entity]));
    const [actions, ...otherActions] = elements(xml, 'Actions');
    const [action, ...otherExecutables] = elements(actions ?? '', 'Exec');
    if (otherActions.length || otherExecutables.length || !action ||
        elements(action, 'Command').join('').toLowerCase() !== windowsAction ||
        elements(action, 'Arguments').join('').toLowerCase() !== windowsJobArguments(home, name).toLowerCase()) {
      return 'action differs';
    }
    const [triggers] = elements(xml, 'Triggers');
    const [trigger, ...otherTriggers] = elements(triggers ?? '', 'CalendarTrigger');
    const boundary = trigger && elements(trigger, 'StartBoundary')[0];
    const dayPattern = new RegExp('^<' + windowsDay + '\\s*/>$', 'i');
    if (!trigger || otherTriggers.length ||
        /<(?:TimeTrigger|BootTrigger|LogonTrigger|EventTrigger|SessionStateChangeTrigger|IdleTrigger|RegistrationTrigger)\b/i.test(triggers) ||
        elements(trigger, 'WeeksInterval').join() !== '1' ||
        !dayPattern.test(elements(trigger, 'DaysOfWeek')[0] ?? '') ||
        boundary?.slice(11, 16) !== windowsTime) return 'cadence differs';
    return disabled ? 'disabled' : 'scheduled';
  }
  if (job.scheduler === 'cron') {
    const list = execute('crontab', ['-l'], { timeout: 2000 });
    const owned = list.status === 0 ? list.stdout.split(/\r?\n/).filter(line =>
      !line.trimStart().startsWith('#') && line.trimEnd().endsWith('# ' + id)) : [];
    if (!owned.length) return 'missing';
    const invocation = owned[0].trim().replace(/^(?:\S+\s+){5}/, '');
    return owned.length === 1 && invocation === cronInvocation(home, name) + ' # ' + id ? 'scheduled' : 'action differs';
  }
  return job.id ? 'registered externally' : 'missing';
}
const cadence = 'weekly ' + windowsDay + ' ' + windowsTime + ' (local time)';
const cronCadence = '0 9 * * 1';
const psQuote = text => `'${text.replaceAll("'", "''")}'`;
const shQuote = text => `'${text.replaceAll("'", "'\\''")}'`;
export const integrationFiles = (root, options) => filesUnder(root, options).filter(path => path.endsWith('.md'));
function antigravityPluginSkillRoots(home) {
  const dir = resolve(home, '.gemini/config/plugins');
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => resolve(dir, entry.name, 'skills'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
/** Refresh file-only companion context; CLI inventory never starts a model session. */
export async function compileIntegrations(project, { home = userHome(), catalog, roots = [], execute = run } = {}) {
  catalog ??= fileURLToPath(new URL(await exists(new URL('../../../integrations', import.meta.url)) ? '../../../integrations' : '../integrations', import.meta.url));
  const skillRoots = [resolve(project, '.claude/skills'), resolve(project, '.agents/skills'), resolve(home, '.claude/skills'), resolve(home, '.agents/skills'), resolve(home, '.gemini/config/skills'), ...antigravityPluginSkillRoots(home), resolve(process.env.CODEX_HOME || resolve(home, '.codex'), 'skills'), ...roots]; const caches = [resolve(home, '.claude/plugins/cache'), resolve(home, '.codex/plugins/cache'), ...(home === userHome() && process.env.CODEX_HOME ? [resolve(process.env.CODEX_HOME, 'plugins/cache')] : [])]; const installed = new Set(), gaps = [], sections = new Map(), suggestions = [], selected = [];
  for (const root of skillRoots) if (await exists(root)) for (const path of filesUnder(root, { skipLinks: true, excludeDirs: ['.git', 'node_modules'] })) if (basename(path) === 'SKILL.md') installed.add(basename(dirname(path)).toLowerCase());
  const collect = value => {
    if (Array.isArray(value)) { for (const row of value) collect(row); return; }
    if (!value || typeof value !== 'object' || value.installed === false || value.enabled === false) return;
    for (const key of ['id', 'name', 'pluginId']) if (typeof value[key] === 'string') installed.add(value[key].split('@')[0].toLowerCase());
    for (const [key, child] of Object.entries(value)) if (typeof child === 'object') { if (key.includes('@') && child?.installed !== false && child?.enabled !== false) installed.add(key.split('@')[0].toLowerCase()); collect(child); }
  };
  for (const host of ['claude', 'codex']) {
    const command = learningCommand(host); if (!command) { gaps.push(`${host}: CLI unavailable`); continue; }
    const result = execute(command.executable, [...command.prefix, 'plugin', 'list', '--json']);
    if (result.status !== 0) { gaps.push(`${host}: plugin inventory unavailable`); continue; }
    try { collect(JSON.parse(result.stdout)); } catch { gaps.push(`${host}: plugin inventory is not JSON`); }
  }
  for (const root of caches) if (await exists(root)) for (const path of filesUnder(root, { skipLinks: true, excludeDirs: ['.git', 'node_modules'] })) if (basename(path) === 'SKILL.md' && installed.has(relative(root, path).replaceAll('\\', '/').split('/')[1]?.toLowerCase())) installed.add(basename(dirname(path)).toLowerCase());
  if (await exists(catalog)) for (const path of integrationFiles(catalog, { skipLinks: true })) {
    const text = await readFile(path, 'utf8'), name = basename(path, '.md'), aliases = /^Skills: (.+)$/m.exec(text)?.[1].split(',').map(name => name.trim().toLowerCase()) ?? [name.toLowerCase()];
    if (![name.toLowerCase(), ...aliases].some(name => installed.has(name))) { suggestions.push(name); continue; }
    selected.push(name);
    for (const match of text.matchAll(/^## With (geppetto-[\w-]+)\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)) {
      const entries = sections.get(match[1]) ?? []; entries.push(`### ${name}\n\n${match[2].trim()}\n\n[Full companion guide](${path.replaceAll('\\', '/')})`); sections.set(match[1], entries);
    }
  }
  const destination = resolve(home, '.geppetto/integrations.md'); await rejectSymlinks(destination); await mkdir(dirname(destination), { recursive: true }); const text = `# Installed companions\n\nProject: ${project.replaceAll('\\', '/')}\n\n` + [...sections].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([skill, entries]) => `## ${skill}\n\n${entries.join('\n\n')}`).join('\n\n') + '\n';
  if (!await exists(destination) || await readFile(destination, 'utf8') !== text) { const temporary = `${destination}.${randomUUID()}.tmp`; await writeFile(temporary, text, { mode: 0o600, flag: 'wx' }); await rename(temporary, destination); }
  return { installed: selected.sort(), suggestions: suggestions.sort(), gaps }; }
/** Resolve disposable version directories while preserving source checkouts. */
export async function maintenanceSource(source) {
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
async function publishLauncher(path, content, missingOnly) {
  await rejectSymlinks(path);
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
  if (!missingOnly) {
    await rename(temporary, path);
    return;
  }
  // Healing may race adoption. Preserve any launcher published by the installer.
  try { await link(temporary, path); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  finally { await unlink(temporary); }
}

export function maintenanceLauncherText(home, source) {
  return `import { readdir, readFile, access, appendFile, mkdir } from 'node:fs/promises';
import { resolve, basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
${maintenanceSource.toString()}
const job = ${JSON.stringify(maintenanceJobs)}.includes(process.argv[3]) ? process.argv[3] : 'unknown';
const directory = ${JSON.stringify(resolve(home, '.geppetto'))};
const credentialAssignment = ${credentialAssignment};
${redact.toString()}
let outcome = 'success';
if (job === 'maintain-memory') outcome = process.argv.includes('--dry-run') ? 'dry run' : 'exit=0';
try {
  const scripts = resolve(await maintenanceSource(${JSON.stringify(source.path)}), 'skills/geppetto-adopt/scripts'); const { main } = await import(pathToFileURL(resolve(scripts, 'maintenance.mjs')).href);
  process.exitCode = (await main(process.argv.slice(2))) ?? 0;
  if (process.exitCode) outcome = 'failure exit=' + process.exitCode;
} catch (error) { outcome = 'failure ' + redact(String(error?.message ?? error)).replace(/[\\r\\n]+/g, ' '); console.error(outcome); process.exitCode = 1; }
finally { await mkdir(directory, { recursive: true }); await appendFile(resolve(directory, job + '.log'), new Date().toISOString() + ' ' + job + ' ' + outcome + '\\n'); }
`;
}
/** Refresh the fixed OS entrypoint while the installer holds the machine lock. */
export async function refreshMaintenanceLauncher(home, source, { missingOnly = false } = {}) {
  const script = resolve(home, '.geppetto/bin/maintenance-launcher.mjs');
  // Embed the resolver so deleting its original plugin cache cannot break this entrypoint.
  await publishLauncher(script, maintenanceLauncherText(home, source), missingOnly);
  return script;
}
export async function refreshWindowsMaintenanceLauncher(home, script, { missingOnly = false } = {}) {
  const launcher = maintenanceWrapper(home);
  const action = `"${process.execPath}" "${script}" --run `;
  await publishLauncher(launcher, `job = "unknown"
If WScript.Arguments.Count = 1 Then job = WScript.Arguments(0)
Select Case job
Case "${maintenanceJobs.join('", "')}"
Case Else: job = "unknown"
End Select
On Error Resume Next
status = CreateObject("WScript.Shell").Run("${action.replaceAll('"', '""')}" & job, 0, True)
If Err.Number <> 0 Then
  Set outputLog = CreateObject("Scripting.FileSystemObject").OpenTextFile("${dirname(launcher)}\\" & job & ".log", 8, True)
  outputLog.WriteLine Now & " " & job & " failure could not start the Node maintenance launcher"
  outputLog.Close
  WScript.Quit 1
End If
WScript.Quit status
`, missingOnly);
  return launcher;
}
function nextWeeklyRun(expression) {
  const match = /^(\d+) (\d+) \* \* ([0-6])$/.exec(expression);
  if (!match || Number(match[1]) > 59 || Number(match[2]) > 23) throw new Error('Inspect the existing cron cadence and register it through --scheduler-jobs with its next run.');
  const now = new Date(), next = new Date(now);
  next.setHours(Number(match[2]), Number(match[1]), 0, 0);
  next.setDate(next.getDate() + (Number(match[3]) - next.getDay() + 7) % 7);
  if (next <= now) next.setDate(next.getDate() + 7);
  return next.toISOString(); }
/** Inspect or attach one OS job; native harness jobs are supplied by adoption first. */
export async function scheduleMaintenance(name, { home = userHome(), host, source, platform = process.platform, execute = run, command = learningCommand(host), previous }) {
  if (!maintenanceJobs.includes(name)) throw new Error('Unknown maintenance job');
  const script = await refreshMaintenanceLauncher(home, source); const id = `Geppetto-${name}`;
  if (platform === 'win32') {
    const available = execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Command Register-ScheduledTask -ErrorAction Stop | Out-Null']);
    if (available.error?.code === 'ENOENT') return null;
    if (available.status !== 0) throw new Error('Windows Task Scheduler is unavailable; inspect PowerShell ScheduledTasks support.');
    if (!command) {
      if (previous?.id) throw new Error(`Install ${host} CLI and sign in before attaching maintenance.`);
      const query = execute('schtasks.exe', ['/Query', '/TN', id, '/XML'], { timeout: 2000 });
      const detail = `${query.stderr ?? ''} ${query.stdout ?? ''}`;
      const absent = !query.error && query.status !== 0 && /cannot find|does not exist|not found|no tasks|impossibile trovare/i.test(detail);
      if (host === 'antigravity' && absent) return null;
      if (query.error || (query.status !== 0 && !absent)) {
        throw new Error(`Cannot inspect Windows maintenance task ${id}: ${query.stderr?.trim() || query.error?.message || `exit ${query.status}`}`);
      }
      throw new Error(`Install ${host} CLI and sign in before attaching maintenance.`);
    }
    await refreshWindowsMaintenanceLauncher(home, script);
    const args = windowsJobArguments(home, name);
    const owned = previous?.id === id && previous.scheduler === 'windows-task-scheduler';
    const observed = owned && maintenanceRegistrationStatus(name, { status: 'scheduled', scheduler: 'windows-task-scheduler' }, { home, execute });
    const reconcile = ['action differs', 'cadence differs'].includes(observed);
    const enable = observed === 'disabled';
    const replacement = reconcile ? 'Set-ScheduledTask -TaskName $id -Action $action -Trigger $trigger | Out-Null;'
      : '';
    const code = `$ErrorActionPreference='Stop'; $id=${psQuote(id)}; $task=Get-ScheduledTask -TaskName $id -ErrorAction SilentlyContinue; $action=New-ScheduledTaskAction -Execute '${windowsAction}' -Argument ${psQuote(args)}; $trigger=New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${windowsDay} -At '${windowsTime}'; if ($task) { ${replacement} if (!$task.Actions.Count -or $task.Actions.Count -ne 1 -or ('${reconcile}' -eq 'false' -and ($task.Actions.Execute -ne '${windowsAction}' -or $task.Actions.Arguments -ne ${psQuote(args)}))) { throw 'Existing task action changed during reconciliation' }; if ('${enable}' -eq 'true') { Enable-ScheduledTask -TaskName $id | Out-Null } } else { $settings=New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable; $task=Register-ScheduledTask -TaskName $id -Action $action -Trigger $trigger -Settings $settings }; $info=Get-ScheduledTaskInfo -TaskName $id; @{id=$id;nextRun=$info.NextRunTime.ToString('o')} | ConvertTo-Json -Compress`; const result = execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')]);
    if (result.status !== 0) throw new Error(`Windows maintenance registration failed: ${result.stderr?.trim() || result.error?.message}`);
    if (reconcile || enable) {
      const verified = maintenanceRegistrationStatus(name, { status: 'scheduled', scheduler: 'windows-task-scheduler' }, { home, execute });
      if (reconcile && verified === 'disabled') {
        return scheduleMaintenance(name, { home, host, source, platform, execute, command, previous });
      }
      if (verified !== 'scheduled') throw new Error('Updated Windows maintenance task did not pass verification.');
    }
    const registered = JSON.parse(result.stdout);
    return { ...registered, scheduler: 'windows-task-scheduler', cadence, disable: `schtasks.exe /Change /TN ${id} /DISABLE`, status: 'scheduled', host };   }
  const listed = execute('crontab', ['-l']);
  if (listed.error?.code === 'ENOENT') return null;
  if (listed.status !== 0 && !/no crontab/i.test(listed.stderr ?? '')) throw new Error(`Cannot inspect crontab: ${listed.stderr?.trim()}`);
  if (!command) {
    const existingCron = previous?.id || (listed.stdout ?? '').split(/\r?\n/).some(line => !line.trimStart().startsWith('#') && line.trimEnd().endsWith(`# ${id}`));
    if (host === 'antigravity' && !existingCron) return null;
    throw new Error(`Install ${host} CLI and sign in before attaching maintenance.`);
  }
  const marker = `# ${id}`; const existing = (listed.stdout ?? '').split('\n').find(line => line.trimEnd().endsWith(marker)); const invocation = cronInvocation(home, name); const expression = existing?.trim().split(/\s+/).slice(0, 5).join(' ') || cronCadence;
  const nextRun = nextWeeklyRun(expression); const entry = `${expression} ${invocation} ${marker}`; const lines = (listed.stdout ?? '').split('\n'); const owned = lines.filter(line => line.trimEnd().endsWith(marker));
  if (owned.length !== 1 || existing?.trimEnd() !== entry) {
    const kept = lines.filter(line => !line.trimEnd().endsWith(marker)).join('\n'); const result = execute('crontab', ['-'], { input: `${kept}${kept.endsWith('\n') ? '' : '\n'}${entry}\n` });
    if (result.status !== 0) throw new Error(`Maintenance crontab registration failed: ${result.stderr?.trim()}`);
  }
  return { scheduler: 'cron', id, cadence: expression, nextRun, disable: `crontab -e (remove ${marker})`, status: 'scheduled', host }; }
/** Remove only the known OS registration; external schedulers need confirmation from adoption. */
export async function disableMaintenance(name, job, { execute = run } = {}) {
  if (job.status === 'disabled') return true;
  if (job.scheduler === 'windows-task-scheduler') {
    if (job.id !== `Geppetto-${name}`) throw new Error('Reconcile the maintenance task identity before disabling it.');
    const result = execute('schtasks.exe', ['/Change', '/TN', job.id, '/DISABLE']);
    if (result.status !== 0) throw new Error(`Cannot disable maintenance task: ${result.stderr?.trim() || result.error?.message}`);
    return true;   }
  if (job.scheduler === 'cron') {
    const listed = execute('crontab', ['-l']);
    if (listed.status !== 0 && !/no crontab/i.test(listed.stderr ?? '')) throw new Error('Cannot inspect maintenance crontab for removal.');
    const text = listed.stdout ?? ''; const kept = text.split('\n').filter(line => !line.trimEnd().endsWith(`# Geppetto-${name}`)).join('\n');
    if (kept !== text && execute('crontab', ['-'], { input: kept }).status !== 0) throw new Error('Cannot remove maintenance crontab entry.');
    return true;   }
  return false; }
/** Run only active registrations with the subscription CLI, inheriting its model settings. */
export async function main(args) {
  if (![2, 3].includes(args.length) || args[0] !== '--run' || !maintenanceJobs.includes(args[1]) || (args.length === 3 && args[2] !== '--dry-run')) throw new Error('Usage: maintenance.mjs --run <curate-skills|maintain-memory> [--dry-run]');
  const machine = await jsonFile(resolve(userHome(), '.geppetto/machine.json')); const job = machine.jobs?.[args[1]];
  if (job?.status !== 'scheduled') return 0;
  const source = new URL('../assets/templates/jobs/' + args[1] + '.md', import.meta.url);
  if (args[1] === 'maintain-memory') {
    const home = userHome();
    if (args[2] === '--dry-run') {
      const checkout = (await memorySettings(home, home))?.localPath;
      console.log(JSON.stringify({ job: args[1], host: 'codex', source: fileURLToPath(source), roots: checkout ? [await realpath(checkout)] : [] }));
      return 0;
    }
    return maintainMemory({ home, job, template: await readFile(source, 'utf8') });
  }
  for (const project of Object.keys(machine.projects ?? {})) if (!await exists(project)) { await writeFile(resolve(userHome(), `.geppetto/${args[1]}.log`), `${new Date().toISOString()} ${args[1]} skipped missing project ${redact(project)}\n`, { flag: 'a' }); delete machine.projects[project]; }
  for (const targets of Object.values(machine.projects ?? {})) for (const [target, source] of Object.entries(targets)) targets[target] = await maintenanceSource(source);
  const procedure = new URL('../../skill-learning-patterns/SKILL.md', import.meta.url);
  const projects = machine.projects ?? {};
  const roots = [...new Set([...Object.keys(projects), ...Object.values(projects).flatMap(Object.values)])];
  if (args[2] === '--dry-run') { console.log(JSON.stringify({ job: args[1], host: job.host ?? 'codex', source: fileURLToPath(source), roots })); return 0; }
  const observedAt = Date.now();
  const { learningAudit } = await import('./audit.mjs'); const reports = await Promise.all(Object.keys(machine.projects ?? {}).map(async project => ({ project, foundations: foundationReport(await jsonFile(resolve(project, '.geppetto/config.json'), {})), evidence: await learningAudit(project), metrics: await boundedMetricsAudit(project, { since: new Date(observedAt - weeklyWindowMs).toISOString(), now: observedAt }).catch(error => ({ status: 'unavailable', reason: error.message })), companions: await compileIntegrations(project) }))); const prompt = `${await readFile(procedure, 'utf8')}\n${await readFile(source, 'utf8')}`; const log = resolve(userHome(), `.geppetto/${args[1]}.log`);
  if (!roots.length) await writeFile(log, 'No configured maintenance destination.\n', { flag: 'a' });
  const output = await open(log, 'a');
  try {
    for (const cwd of roots) {
      await output.write(`${cwd}\n${JSON.stringify({ reports })}\n`);
      const metrics = reports.find(report => report.project === cwd)?.metrics;
      const available = metrics && metrics.status !== 'unavailable';
      const draft = available ? await newWeeklyDraft(cwd) : undefined;
      try {
        const localReports = reports.map(({ metrics, ...report }) => report.project === cwd && metrics ? { ...report, metrics } : report);
        const context = JSON.stringify({ projects: machine.projects, memory: machine.memory, reports: localReports });
        const request = prompt + '\nResolved machine context: ' + context + '. Work within the supplied file tools. Keep changes local for review.\n';
        await executeLearning({ cwd, prompt: request, host: job.host ?? 'codex', output: output.fd,
          maintenance: true, weeklyDraft: draft });
        if (available) {
          const path = await publishWeeklyReport(cwd, metrics, { draft });
          await output.write('Weekly metrics report: ' + path + '\n');
        }
      } finally {
        await disposeWeeklyDraft(draft);
      }
    }
  } finally { await output.close(); }
  const failed = reports.filter(row => row.metrics?.status === 'unavailable');
  if (failed.length) throw new Error('Weekly metrics audit unavailable for ' + failed.length + ' project(s); previous reports were preserved.');
  return 0; }
if (isMain(import.meta.url)) await cli(main);
