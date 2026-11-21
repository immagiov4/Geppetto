import { appendRecord, atomicJson, exists, ignoreLocalFiles, isMain, jsonFile, projectRoot, run, userHome } from './common.mjs';
import { worktreePaths } from './project-records.mjs';
import { metricDiagnostic } from './metrics.mjs';
import { turnStatePath } from './turn-messages.mjs';
import { mkdir } from 'node:fs/promises';
import { lstatSync, readdirSync, statfsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { hostname, tmpdir } from 'node:os';
const probeTimeout = 2500, sizeBudget = 90000, largestChildLimit = 5;
export const resourceHost = hostname();
export function resourceProbe({ execute = run, platform = process.platform } = {}) {
  const windows = platform === 'win32';
  const script = "Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { '{0} {1} {2} {3} {4}' -f $_.ProcessId,$_.ParentProcessId,([long]$_.CreationDate.Ticks),$_.WorkingSetSize,$_.Name }";
  const result = windows ? execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: probeTimeout })
    : execute('ps', ['-eo', 'pid=,ppid=,lstart=,rss=,comm='], { timeout: probeTimeout, env: { ...process.env, LC_ALL: 'C' } });
  if (result.status !== 0) throw new Error(result.error?.code ?? 'Process probe failed');
  return result.stdout.split(/\r?\n/).filter(Boolean).map(line => {
    const [, pid, parent, start, rss, name] = line.trim().match(windows ? /^(\d+) (\d+) (\d+) (\d+) (.+)$/ : /^(\d+)\s+(\d+)\s+(.{24})\s+(\d+)\s+(.+)$/) ?? [];
    if (!name) throw new Error('Invalid process snapshot');
    return [+pid, +parent, start, name, +rss * (windows ? 1 : 1024)];
  });
}
const identity = ([pid, , start]) => pid + ':' + start;
export function processDelta(baseline, current, hookPid) {
  const prior = new Set(baseline.map(identity)), parents = new Map(current.map(([pid, parent]) => [pid, parent]));
  const reaches = (pid, target) => {
    for (let remaining = parents.size; pid > 0 && remaining--; pid = parents.get(pid)) if (pid === target) return true;
    return false;
  };
  const newProcesses = current.filter(row => !prior.has(identity(row)) && !reaches(hookPid, row[0]) && !reaches(row[1], hookPid));
  const groups = Map.groupBy(newProcesses, ([, , , name]) => {
    const executable = name.toLowerCase().replace(/\.exe$/, '');
    if (/^(chrome|msedge|chromium|firefox)(-bin)?$/.test(executable)) return 'browser';
    return /^python(\d+(\.\d+)?)?w?$/.test(executable) ? 'python' : executable;
  });
  return ['browser', 'bun', 'node', 'python'].filter(family => groups.has(family)).map(family => {
    const processes = groups.get(family);
    return { family, count: processes.length, residentBytes: processes.reduce((bytes, row) => bytes + row[4], 0) };
  });
}
export async function captureResources(event, { home = userHome(), runCommand = run } = {}) {
  let root = resolve(event.cwd ?? '.');
  try {
    root = await projectRoot(root);
    if (!await exists(resolve(root, '.git'))) return;
    const path = turnStatePath(root, event.session_id) + '.resources.json';
    if (event.hook_event_name === 'SessionStart') {
      await ignoreLocalFiles(root, ['/hook-state/']);
      await mkdir(dirname(path), { recursive: true });
      await atomicJson(path, resourceProbe({ execute: runCommand }).map(([pid, , start]) => [pid, null, start]));
      return;
    }
    const baseline = await jsonFile(path, null);
    if (!baseline) throw new Error('Missing SessionStart process snapshot');
    const processes = processDelta(baseline, resourceProbe({ execute: runCommand }), process.pid);
    const volumes = await filesystemProbe('volumes', [root, home, tmpdir()], probeTimeout);
    await appendRecord(root, 'metrics', { kind: 'resource', key: 'stop', host: resourceHost, ts: new Date().toISOString(), sessionId: event.session_id, worktreeCount: worktreePaths(root, runCommand).length, volumes, processes });
  } catch (error) {
    await metricDiagnostic(root, event, error.killed ? new Error('Filesystem probe deadline') : error);
  }
}
const executeFile = promisify(execFile);
async function filesystemProbe(mode, args, timeout) {
  const result = await executeFile(process.execPath, [fileURLToPath(import.meta.url), mode, ...args], { timeout, windowsHide: true, killSignal: 'SIGKILL' });
  return JSON.parse(result.stdout);
}
export async function sizeRoot(root, budget = sizeBudget, includeChildren = false) {
  try { return await filesystemProbe('size', [root, String(budget), String(includeChildren)], budget + probeTimeout); }
  catch (error) { return { status: 'partial', bytes: 0, skipped: root, reason: error.killed ? 'deadline' : 'probe failure' }; }
}
function scan(root, budget, includeChildren) {
  const deadline = performance.now() + budget;
  let bytes = 0, current = root;
  const children = [];
  function visit(path) {
    current = path;
    if (performance.now() >= deadline) throw new Error('deadline');
    const entry = lstatSync(path);
    if (entry.isFile()) bytes += entry.size;
    if (entry.isDirectory()) for (const child of readdirSync(path, { withFileTypes: true })) {
      if (!child.isFile() && !child.isDirectory()) continue;
      const before = bytes;
      visit(resolve(path, child.name));
      if (includeChildren && path === root && child.isDirectory()) children.push({ name: child.name, bytes: bytes - before });
    }
  }
  try { visit(root); if (performance.now() >= deadline) throw new Error('deadline'); return { status: 'complete', bytes, ...(includeChildren && {
    largestChildren: children.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name)).slice(0, largestChildLimit)
  }) }; }
  catch (error) { return error.code === 'ENOENT' && current === root ? { status: 'missing', bytes } : { status: 'partial', bytes, skipped: current, reason: error.code ?? error.message }; }
}
if (isMain(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  const result = mode === 'size' ? scan(args[0], Number(args[1]), args[2] === 'true') : Object.fromEntries(args.map((path, index) => {
    const { bsize, bavail, blocks } = statfsSync(path);
    return [['project', 'home', 'temp'][index], { freeBytes: bavail * bsize, totalBytes: blocks * bsize }];
  }));
  console.log(JSON.stringify(result));
}
