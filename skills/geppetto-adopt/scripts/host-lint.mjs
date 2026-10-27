import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cli, isMain, parseArgs, UsageError, exists, jsonFile, run } from './common.mjs';

const baseVendored = ['.agents/skills/**', '.geppetto/**'];
const configurations = /^(?:biome\.jsonc?|eslint(?:\..+)?\.config\.[cm]?[jt]s|eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\..+)?|\.eslintignore|\.prettierignore|\.prettierrc(?:\..+)?|prettier\.config\.[cm]?[jt]s)$/;

/** Propose host-owned ignore changes; run the host's affected-file check only during verification. */
export async function hostLintReport(project, verify = false) {
  const vendored = [...baseVendored, ...(await exists(resolve(project, '.claude/skills')) ? ['.claude/skills/**'] : [])];
  const configs = [];
  for (const directory of ['.', 'config', '.config']) {
    const root = resolve(project, directory);
    if (!await exists(root)) continue;
    for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isFile() && configurations.test(entry.name)) {
      const path = directory === '.' ? entry.name : `${directory}/${entry.name}`;
      const tool = /biome/.test(entry.name) ? 'Biome' : /eslint/.test(entry.name) ? 'ESLint' : 'Prettier';
      const content = await readFile(resolve(project, path), 'utf8');
      const biomeOne = /schemas\/1\./.test(content);
      const patterns = tool === 'Biome' && !biomeOne ? vendored.map(path => `!!**/${path.slice(0, -3)}`) : vendored;
      configs.push({ path, tool, patterns, registration: patterns.every(pattern => content.includes(pattern)) ? 'present-in-config' : 'proposed', instruction: tool === 'Biome' ? `Add these patterns to files.${biomeOne ? 'ignore' : 'includes'}.` : tool === 'ESLint' ? 'Add these patterns to a global ignores entry, or the existing ignore file.' : 'Add these patterns to .prettierignore.' });
    }
  }
  configs.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const configPath = resolve(project, '.geppetto/config.json');
  const settings = await jsonFile(configPath, {});
  const pkg = await jsonFile(resolve(project, 'package.json'), {});
  let command = settings.hostChecks?.changed;
  if (command === undefined && pkg.scripts?.['check:changed'] && pkg.packageManager?.startsWith('bun@')) command = ['bun', 'run', 'check:changed'];
  if (command !== undefined && (!Array.isArray(command) || !command.length || command.some(part => typeof part !== 'string' || !part.trim()))) throw new Error(`${configPath}:1: hostChecks.changed must be a nonempty argv array`);
  const check = { status: 'not-verified', command: command ?? null, reason: command ? 'Run --verify after registering host ignore changes' : 'Record the host affected-file command as hostChecks.changed (argv array) in .geppetto/config.json', suggestedCommand: pkg.scripts?.['check:changed'] ? `${pkg.packageManager?.split('@')[0] ?? 'npm'} run check:changed` : null };
  if (verify && command) {
    const result = run(command[0], command.slice(1), { cwd: project, timeout: 0 });
    Object.assign(check, { status: result.status === 0 ? 'pass' : 'fail', exitCode: result.status, stdout: result.stdout, stderr: result.stderr, reason: result.error?.message ?? (result.status === 0 ? 'Host affected-file check passed' : 'Host affected-file check failed; inspect its diagnostics') });
  }
  return { vendored, configurations: configs, check };
}

export async function main(args) {
  const opts = parseArgs(args, { values: ['--project'], flags: ['--json', '--verify'] });
  if (opts._.length) throw new UsageError('Usage: host-lint.mjs [--project <dir>] [--json] [--verify]');
  const report = await hostLintReport(resolve(opts['--project'] ?? '.'), opts['--verify']);
  if (opts['--json']) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('Vendored paths: register generated paths in host ignore configuration.');
    for (const config of report.configurations) console.log(`${config.path}:1: ${config.registration}: ${config.instruction} ${config.patterns.join(', ')}`);
    console.log(`${report.check.status === 'pass' ? 'PASS' : report.check.status === 'fail' ? 'FAIL' : 'ACTION'} host-affected-file-check: ${report.check.reason}`);
    if (report.check.stdout) process.stdout.write(report.check.stdout);
    if (report.check.stderr) process.stderr.write(report.check.stderr);
  }
  return report.check.status === 'fail' ? 1 : 0;
}

if (isMain(import.meta.url)) await cli(main);
