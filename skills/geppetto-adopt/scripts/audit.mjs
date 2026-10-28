import { mkdtemp, writeFile, rm, stat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { cli, isMain, parseArgs, UsageError, jsonFile, validateConfig, userHome, run, skillSelectorDefaults } from './common.mjs';
import { hostLintReport } from './host-lint.mjs';
import { memorySettings, memoryConfiguration } from './memory-config.mjs';
import { learningReadiness } from './learn-runner.mjs';
import { validateSkillSelectorSettings } from './skill-catalog.mjs';
const status = value => value ? 'present' : 'absent';
const repositoryIdentity = value => /^https?:\/\//.test(value) ? value.replace(/\.git$/, '') : value;
async function directory(path) { try { return (await stat(path)).isDirectory(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function file(path) { try { return (await stat(path)).isFile(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function memoryReport(project) {
  const merged = await memorySettings(project);
  if (!merged) return { status: 'absent', ...(await memoryConfiguration(project)), reason: 'No bucket memory configured' };
  const localPath = merged.localPath;
  const rootIndex = localPath ? resolve(localPath, 'index.md') : null;
  const bucketIndex = localPath && merged.buckets.length === 1 ? resolve(localPath, 'buckets', merged.buckets[0], 'index.md') : null;
  const bucketIndexes = await Promise.all(merged.buckets.map(async bucket => ({ bucket, path: localPath ? resolve(localPath, 'buckets', bucket, 'index.md') : null, status: status(localPath && await file(resolve(localPath, 'buckets', bucket, 'index.md'))) })));
  const root = localPath && await directory(localPath) ? run('git', ['rev-parse', '--show-toplevel'], { cwd: localPath }) : null;
  const cloneExists = Boolean(root?.status === 0 && await realpath(resolve(root.stdout.trim())) === await realpath(localPath));
  const remote = cloneExists ? run('git', ['remote'], { cwd: localPath }) : null;
  const names = remote?.status === 0 ? remote.stdout.trim().split(/\r?\n/).filter(Boolean) : [];
  const selected = names.includes('origin') ? 'origin' : names.length === 1 ? names[0] : null;
  const url = selected ? run('git', ['remote', 'get-url', '--all', selected], { cwd: localPath }) : null;
  const push = selected ? run('git', ['remote', 'get-url', '--push', '--all', selected], { cwd: localPath }) : null;
  const urls = url?.status === 0 ? url.stdout.trim().split(/\r?\n/).filter(Boolean) : [];
  const pushUrls = push?.status === 0 ? push.stdout.trim().split(/\r?\n/).filter(Boolean) : [];
  const matchesConfigured = Boolean(merged.repo && (urls.length && pushUrls.length ? [...urls, ...pushUrls].every(value => repositoryIdentity(value) === repositoryIdentity(merged.repo)) : cloneExists && !names.length && resolve(merged.repo) === resolve(localPath)));
  return { status: 'configured', ...merged, localPath, clone: status(cloneExists), rootIndex: { path: rootIndex, status: status(rootIndex && await file(rootIndex)) }, projectBucketIndex: { path: bucketIndex, status: status(bucketIndex && await file(bucketIndex)) }, bucketIndexes, remote: { status: remote ? remote.status === 0 ? status(Boolean(remote.stdout.trim())) : 'unverifiable' : 'absent', names, selected, urls, pushUrls, matchesConfigured } };
}

async function verify(project) {
  const checks = [];
  const configPath = resolve(project, '.geppetto/config.json');
  try { validateConfig(await jsonFile(configPath), configPath); checks.push({ name: 'config', pass: true }); }
  catch (error) { checks.push({ name: 'config', pass: false, reason: error.message }); }
  const agentGate = fileURLToPath(new URL('./gate-agents.mjs', import.meta.url));
  const sectionGate = fileURLToPath(new URL('./gate-sections.mjs', import.meta.url));
  const temp = await mkdtemp(resolve(tmpdir(), 'geppetto-audit-'));
  try {
    await writeFile(resolve(temp, 'AGENTS.md'), '# Router\n');
    await writeFile(resolve(temp, 'large.md'), '# Router\nExtra\n');
    await writeFile(resolve(temp, 'config.json'), JSON.stringify({ sections: { pr: ['Observability'] } }));
    const fixtures = [
      { name: 'sections-valid-fixture', script: sectionGate, args: ['--pr', '-', '--config', resolve(temp, 'config.json')], input: '## Observability\nNot applicable: spelling only.', expected: 0 },
      { name: 'sections-invalid-fixture', script: sectionGate, args: ['--pr', '-', '--config', resolve(temp, 'config.json')], input: '```\n## Observability\nLogs\n```', expected: 1 },
      { name: 'agents-valid-fixture', script: agentGate, args: ['--file', resolve(temp, 'AGENTS.md')], expected: 0 },
      { name: 'agents-invalid-fixture', script: agentGate, args: ['--file', resolve(temp, 'large.md'), '--max-lines', '1'], expected: 1 },
      { name: 'project-agents-budget', script: agentGate, args: ['--file', resolve(project, 'AGENTS.md')], expected: 0 },
    ];
    for (const fixture of fixtures) {
      if (!await file(fixture.script)) { checks.push({ name: fixture.name, pass: false, reason: `${fixture.script}:1: Installed gate missing` }); continue; }
      const result = run(process.execPath, [fixture.script, ...fixture.args], { cwd: project, input: fixture.input });
      checks.push({ name: fixture.name, pass: result.status === fixture.expected, exitCode: result.status, reason: result.status === fixture.expected ? undefined : result.stderr?.trim() || result.error?.message || 'Unexpected gate result' });
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
  return checks;
}

export async function main(args) {
  const opts = parseArgs(args, { values: ['--project'], flags: ['--json', '--verify'] });
  if (opts._.length) throw new UsageError('Usage: audit.mjs [--project <dir>] [--json] [--verify]');
  const project = resolve(opts['--project'] ?? '.');
  if (!await directory(project)) throw new Error(`${project}:1: Project directory does not exist`);
  const config = await jsonFile(resolve(project, '.geppetto/config.json'), {});
  const machine = await jsonFile(resolve(userHome(), '.geppetto/machine.json'), {});
  const user = await jsonFile(resolve(userHome(), '.geppetto/config.json'), {});
  const ready = (settings, validate) => {
    if (settings.enabled === false) return { enabled: false, action: null };
    try { validate(settings); } catch { return { enabled: false, action: 'Repair the hook settings in .geppetto/config.json.' }; }
    return { enabled: Boolean(process.env.OPENROUTER_API_KEY), action: process.env.OPENROUTER_API_KEY ? null : 'Add OPENROUTER_API_KEY for skill suggestions.' };
  };
  const report = { project, node: { version: process.versions.node, status: Number(process.versions.node.split('.')[0]) >= 22 ? 'present' : 'absent' }, installed: Object.keys((await jsonFile(resolve(project, '.geppetto/install.json'), { installations: {} })).installations), machine, memory: await memoryReport(project), hostLint: await hostLintReport(project, opts['--verify']), learning: learningReadiness(project, config.hooks?.signalLearning), skillSelector: ready({ ...skillSelectorDefaults, ...user.hooks?.skillSelector, ...config.hooks?.skillSelector }, validateSkillSelectorSettings) };
  if (opts['--verify']) {
    report.verification = await verify(project);
    if (report.memory.status === 'configured') report.verification.push({ name: 'memory-remote-url', pass: report.memory.remote.matchesConfigured, reason: report.memory.remote.matchesConfigured ? undefined : 'Memory fetch/push remote URL does not equal configured memory.repo' });
    if (report.hostLint.check.status !== 'not-verified') report.verification.push({ name: 'host-affected-file-check', pass: report.hostLint.check.status === 'pass', reason: report.hostLint.check.reason });
  }
  if (opts['--json']) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Geppetto audit: ${project}\nNode ${report.node.version} (minimum 22)`);
    console.log(`Installed: ${report.installed.join(', ') || 'run adoption'}`);
    console.log(`Hooks: ${Object.keys(machine.hooks ?? {}).join(', ') || 'run adoption'}`);
    console.log(`Memory: ${report.memory.status}`);
    for (const [name, job] of Object.entries(machine.jobs ?? {})) console.log(`Job ${name}: ${job.status}${job.status === 'needs-scheduler' ? '; attach an available scheduler' : ''}`);
    for (const [name, readiness] of [['Signal learning', report.learning], ['Skill selector', report.skillSelector]]) console.log(`${name}: ${readiness.enabled ? 'enabled' : name === 'Signal learning' && readiness.action ? 'not ready' : 'disabled'}${readiness.action ? `; ${readiness.action}` : ''}`);
    for (const configuration of report.hostLint.configurations) console.log(`Host ${configuration.tool}: ${configuration.path}:1: ${configuration.registration}; ${configuration.patterns.join(', ')}`);
    for (const check of report.verification ?? []) console.log(`${check.pass ? 'PASS' : 'FAIL'} ${check.name}${check.reason ? `: ${check.reason}` : ''}`);
  }
  return report.node.status === 'absent' || report.verification?.some(c => !c.pass) ? 1 : 0;
}
if (isMain(import.meta.url)) await cli(main);
