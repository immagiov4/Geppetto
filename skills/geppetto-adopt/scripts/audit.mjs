import { readdir, mkdtemp, writeFile, rm, stat, realpath } from 'node:fs/promises';
import { resolve, delimiter, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { cli, isMain, parseArgs, UsageError, exists, jsonFile, validateConfig, validateMemory, userHome, run } from './common.mjs';
import { hostLintReport } from './host-lint.mjs';
import { memorySettings } from './memory-config.mjs';
import { learningReadiness } from './learning-config.mjs';
import { fileURLToPath } from 'node:url';
import { validateClassifierSettings } from './memory-classifier.mjs';

const status = value => value ? 'present' : 'absent';
const repositoryIdentity = value => /^https?:\/\//.test(value) ? value.replace(/\.git$/, '') : value;
async function directory(path) { try { return (await stat(path)).isDirectory(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function file(path) { try { return (await stat(path)).isFile(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function entries(path) { return await directory(path) ? (await readdir(path)).sort() : []; }
async function executable(name) {
  const suffixes = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const path of (process.env.PATH ?? '').split(delimiter)) for (const suffix of suffixes) {
    const candidate = resolve(path, `${name}${suffix.toLowerCase()}`);
    if (await file(candidate)) return candidate;
  }
  return null;
}

async function memoryReport(project) {
  const merged = await memorySettings(project);
  if (!merged) return { status: 'absent', reason: 'No memory repository configured' };
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
  const matchesConfigured = Boolean(merged.repo && urls.length && pushUrls.length && [...urls, ...pushUrls].every(value => repositoryIdentity(value) === repositoryIdentity(merged.repo)));
  return { status: 'configured', ...merged, localPath, clone: status(cloneExists), rootIndex: { path: rootIndex, status: status(rootIndex && await file(rootIndex)) }, projectBucketIndex: { path: bucketIndex, status: status(bucketIndex && await file(bucketIndex)) }, bucketIndexes, remote: { status: remote ? remote.status === 0 ? status(Boolean(remote.stdout.trim())) : 'unverifiable' : 'absent', names, selected, urls, pushUrls, matchesConfigured } };
}

async function harnesses(project) {
  const home = userHome();
  const definitions = {
    claude: { command: 'claude', skills: [resolve(project, '.claude/skills'), resolve(home, '.claude/skills')], instructions: ['CLAUDE.md', 'CLAUDE.local.md'], hooks: [resolve(project, '.claude/settings.json'), resolve(home, '.claude/settings.json')], scheduling: 'CLI scheduled tasks or external scheduler; confirm in the active session' },
    codex: { command: 'codex', skills: [resolve(project, '.agents/skills'), resolve(home, '.agents/skills')], instructions: ['AGENTS.md', 'AGENTS.override.md'], hooks: [resolve(project, '.codex/hooks.json'), resolve(process.env.CODEX_HOME ?? resolve(home, '.codex'), 'hooks.json')], scheduling: 'Desktop automations; confirm the app is running and the job is enabled' },
    pi: { command: 'pi', skills: [resolve(project, '.pi/skills'), resolve(home, '.pi/agent/skills')], instructions: ['AGENTS.md'], hooks: [resolve(project, '.pi/extensions')], scheduling: 'External scheduler plus noninteractive CLI' },
    opencode: { command: 'opencode', skills: [resolve(project, '.agents/skills'), resolve(project, '.opencode/skills'), resolve(home, '.config/opencode/skills')], instructions: ['AGENTS.md'], hooks: [resolve(project, '.opencode/plugins')], scheduling: 'External scheduler plus noninteractive CLI' },
  };
  for (const definition of Object.values(definitions)) {
    const binary = await executable(definition.command);
    definition.binary = { path: binary, status: status(binary) };
    definition.skills = await Promise.all(definition.skills.map(async path => ({ path, status: status(await directory(path)), entries: await entries(path) })));
    definition.instructions = await Promise.all(definition.instructions.map(async name => ({ path: resolve(project, name), status: status(await file(resolve(project, name))) })));
    definition.hooks = { status: 'unverifiable', locations: await Promise.all(definition.hooks.map(async path => ({ path, status: status(await exists(path)) }))), reason: 'Presence of configuration does not establish hook enablement or trust' };
    definition.scheduling = { status: 'unverifiable', guidance: definition.scheduling };
    definition.skillLoading = { status: 'unverifiable', reason: 'Check actual loaded instructions and skills in a fresh harness session' };
  }
  return definitions;
}

async function verify(project) {
  const checks = [];
  const configPath = resolve(project, '.geppetto/config.json');
  try { validateConfig(await jsonFile(configPath), configPath); checks.push({ name: 'config', pass: true }); }
  catch (error) { checks.push({ name: 'config', pass: false, reason: error.message }); }
  const agentGate = resolve(project, '.geppetto/bin/gate-agents.mjs');
  const sectionGate = resolve(project, '.geppetto/bin/gate-sections.mjs');
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
  const report = { project, node: { version: process.versions.node, status: Number(process.versions.node.split('.')[0]) >= 22 ? 'present' : 'absent', minimum: 22 }, tools: {}, harnesses: await harnesses(project), projectFiles: {}, memory: await memoryReport(project), hostLint: await hostLintReport(project, opts['--verify']), learning: await learningReadiness(project) };
  const user = await jsonFile(resolve(userHome(), '.geppetto/config.json'), {});
  const classifier = { ...user.hooks?.memoryClassifier, ...config.hooks?.memoryClassifier };
  const classifierGrant = run(process.execPath, [fileURLToPath(new URL('./authz.mjs', import.meta.url)), 'check', 'memory-classifier', '--provider', 'openrouter', '--cost', classifier.maxCostUsd == null ? 'none' : String(classifier.maxCostUsd)], { cwd: project });
  let settingsValid = true;
  try { validateClassifierSettings(classifier); } catch { settingsValid = false; }
  const classifierAction = classifier.enabled === false ? 'Memory classifier is declined in hooks.memoryClassifier.enabled.' : !process.env.OPENROUTER_API_KEY ? 'Add OPENROUTER_API_KEY to the hook launcher through its secret store, then rerun adoption.' : !settingsValid ? 'Select the classifier model and traversal settings in the adoption question round.' : classifierGrant.status !== 0 ? 'Record the accepted standing OpenRouter memory-classifier grant in user and project authorizations.' : null;
  report.memoryClassifier = { enabled: classifierAction === null, benchmark: classifier.benchmark ?? null, action: classifierAction };
  for (const command of ['git', 'gh']) { const probe = run(command, ['--version']); report.tools[command] = { status: probe.status === 0 ? 'present' : probe.error?.code === 'ENOENT' ? 'absent' : 'unverifiable', version: probe.status === 0 ? probe.stdout.trim().split(/\r?\n/)[0] : null }; }
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'package.json', config.docs?.root ?? 'docs', 'tests', 'test', '.github/workflows', '.gitlab-ci.yml', 'azure-pipelines.yml', '.geppetto']) report.projectFiles[name] = status(await exists(resolve(project, name)));
  if (opts['--verify']) {
    report.verification = await verify(project);
    if (report.memory.status === 'configured') report.verification.push({ name: 'memory-remote-url', pass: report.memory.remote.matchesConfigured, reason: report.memory.remote.matchesConfigured ? undefined : 'Memory fetch/push remote URL does not equal configured memory.repo' });
    if (report.hostLint.check.status !== 'not-verified') report.verification.push({ name: 'host-affected-file-check', pass: report.hostLint.check.status === 'pass', reason: report.hostLint.check.reason });
    report.verificationGaps = [
      { name: 'hook-trust', reason: 'Review and trust hooks in each active harness' },
      { name: 'instruction-loading', reason: 'Identify actual loaded instruction sources in a fresh harness session' },
      { name: 'skill-loading', reason: 'Exercise actual skill discovery and loading in a fresh harness session' },
      { name: 'remote-ci', reason: 'Observe the gate on the remote PR, including first-adoption bootstrap' },
      { name: 'provider-spend-limits', reason: 'Verify limits at the provider; consent files alone do not enforce them' },
    ];
    if (report.hostLint.check.status === 'not-verified') report.verificationGaps.push({ name: 'host-affected-file-check', reason: report.hostLint.check.reason });
  }
  if (opts['--json']) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Geppetto audit: ${project}\nNode ${report.node.version} (minimum 22)`);
    for (const [name, tool] of Object.entries(report.tools)) console.log(`${name}: ${tool.status}`);
    for (const [name, harness] of Object.entries(report.harnesses)) console.log(`${name}: ${harness.binary.status}; skill loading, hook trust and scheduled tasks: unverifiable in this process\n  skills: ${harness.skills.map(s => `${s.path} (${s.status})`).join(', ')}\n  instructions: ${harness.instructions.map(s => `${s.path} (${s.status})`).join(', ')}\n  hooks: ${harness.hooks.locations.map(s => `${s.path} (${s.status})`).join(', ')}\n  scheduling: ${harness.scheduling.guidance}`);
    for (const [name, state] of Object.entries(report.projectFiles)) console.log(`${name}: ${state}`);
    console.log(`Memory: ${JSON.stringify(report.memory)}`);
    for (const [name, readiness] of [['Signal learning', report.learning], ['Memory classifier', report.memoryClassifier]]) console.log(`${name}: ${readiness.enabled ? 'enabled' : 'disabled'}${readiness.action ? `; ${readiness.action}` : ''}`);
    for (const configuration of report.hostLint.configurations) console.log(`Host ${configuration.tool}: ${configuration.path}:1: ${configuration.registration}; owner consent required: ${configuration.patterns.join(', ')}`);
    for (const check of report.verification ?? []) console.log(`${check.pass ? 'PASS' : 'FAIL'} ${check.name}${check.reason ? `: ${check.reason}` : ''}`);
    for (const gap of report.verificationGaps ?? []) console.log(`NOT VERIFIED ${gap.name}: ${gap.reason}`);
  }
  return report.node.status === 'absent' || report.verification?.some(c => !c.pass) ? 1 : 0;
}

if (isMain(import.meta.url)) await cli(main);
