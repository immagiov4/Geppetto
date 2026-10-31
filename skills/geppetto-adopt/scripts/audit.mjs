import { mkdtemp, writeFile, rm, stat, realpath } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { cli, isMain, parseArgs, UsageError, jsonFile, validateConfig, userHome, run, filesUnder, exists, foundationReport, contained } from './common.mjs';
import { localRecords, learningPolicy, signalArchive } from './signal.mjs';
import { hostLintReport } from './host-lint.mjs';
import { memorySettings, memoryConfiguration } from './memory-config.mjs';
import { learningReadiness } from './learn-runner.mjs';
import { turnMetrics, validateTurnPolicy, userTurnDecision } from './turn-checks.mjs';
import { readKind } from './hook-events.mjs';
import { projectDataPath } from './project-records.mjs';
const status = value => value ? 'present' : 'absent';
const repositoryIdentity = value => /^https?:\/\//.test(value) ? value.replace(/\.git$/, '') : value;
/** Counts and observed reads only; missing observations are never inferred as usage. */
export async function learningAudit(project, { home = userHome(), since, now = Date.now() } = {}) {
  const policy = learningPolicy(await jsonFile(resolve(project, '.geppetto/config.json'), {})), memory = await memorySettings(project, home); if (since !== undefined && !Number.isFinite(Date.parse(since))) throw new UsageError('--since must be an ISO date.'); const start = since ?? (policy.outcomeWeeks ? new Date(now - policy.outcomeWeeks * 7 * 24 * 60 * 60 * 1000).toISOString() : ''), startTime = start ? Date.parse(start) : -Infinity; const reads = await localRecords(project, 'reads'), signals = (await localRecords(project, 'signals')), archive = (await signalArchive(project)); const seen = (path, after) => reads.some(row => resolve(row.worktree && contained(row.worktree, row.path) ? resolve(project, relative(row.worktree, row.path)) : row.path) === resolve(path) && Date.parse(row.ts) >= after);
  const machine = await jsonFile(resolve(home, '.geppetto/machine.json'), {}); const roots = [resolve(project, '.agents/skills'), resolve(project, '.claude/skills'), resolve(home, '.claude/skills'), resolve(home, '.agents/skills'), resolve(home, '.codex/skills'), ...Object.values(machine.projects?.[project] ?? {}).map(source => resolve(source, 'skills'))];
  if (memory?.localPath) roots.push(resolve(memory.localPath, 'buckets'));
  const pages = [...new Set(roots.flatMap(root => {
    try { return filesUnder(root, { skipLinks: true, excludeDirs: ['.git', 'node_modules'] }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }).filter(path => readKind(path, memory, project)))];
  if (memory?.localPath && readKind(resolve(memory.localPath, 'index.md'), memory, project) && await exists(resolve(memory.localPath, 'index.md'))) pages.push(resolve(memory.localPath, 'index.md'));
  const outcomes = signals.filter(row => row.status === 'resolved' && Date.parse(row.ts) >= startTime && row.paths?.length).map(change => { const neverRead = change.paths.filter(path => readKind(resolve(project, path), memory, project) && !seen(resolve(project, path), Date.parse(change.ts))); return { key: change.key, reference: change.reference, didNotFix: signals.some(row => row.key === change.key && row.session && (Date.parse(row.ts) > Date.parse(change.ts) || signals.indexOf(row) > signals.indexOf(change))), neverRead, candidateToRevert: neverRead.length > 0 }; }); const turns = (await localRecords(project, 'turns')).filter(row => Date.parse(row.ts) >= startTime).map(userTurnDecision);
  return { since: start || null, openKeys: archive.filter(row => row.status === 'open' && !row.legacy).map(row => row.key), openEvidence: archive.filter(row => row.status === 'open' && !row.legacy), neverRead: pages.filter(path => !seen(path, startTime)), outcomes, categories: policy.categories.map(category => ({ ...category, keys: archive.filter(row => row.category === category.id).length, sessions: new Set(signals.filter(row => row.category === category.id && row.session && Date.parse(row.ts) >= startTime).map(row => `${row.key}\0${row.session}`)).size })), userFriction: { flagged: turns.filter(row => row.feedback?.applies || row.frustration?.applies).length, turns: turns.length, unclassified: turns.filter(row => typeof row.feedback?.applies !== 'boolean' || typeof row.frustration?.applies !== 'boolean').length }, other: archive.filter(row => row.category === 'other'), legacy: archive.filter(row => row.legacy || row.metric && !row.category), proposals: (await localRecords(project, 'category-proposals')) }; }
async function directory(path) { try { return (await stat(path)).isDirectory(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function file(path) { try { return (await stat(path)).isFile(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function memoryReport(project) {
  const merged = await memorySettings(project);
  if (!merged) return { status: 'absent', ...(await memoryConfiguration(project)), reason: 'No bucket memory configured' };
  const localPath = merged.localPath; const rootIndex = localPath ? resolve(localPath, 'index.md') : null; const bucketIndex = localPath && merged.buckets.length === 1 ? resolve(localPath, 'buckets', merged.buckets[0], 'index.md') : null; const bucketIndexes = await Promise.all(merged.buckets.map(async bucket => ({ bucket, path: localPath ? resolve(localPath, 'buckets', bucket, 'index.md') : null, status: status(localPath && await file(resolve(localPath, 'buckets', bucket, 'index.md'))) }))); const root = localPath && await directory(localPath) ? run('git', ['rev-parse', '--show-toplevel'], { cwd: localPath }) : null;
  const cloneExists = Boolean(root?.status === 0 && await realpath(resolve(root.stdout.trim())) === await realpath(localPath)); const remote = cloneExists ? run('git', ['remote'], { cwd: localPath }) : null; const names = remote?.status === 0 ? remote.stdout.trim().split(/\r?\n/).filter(Boolean) : []; const selected = names.includes('origin') ? 'origin' : names.length === 1 ? names[0] : null;
  const url = selected ? run('git', ['remote', 'get-url', '--all', selected], { cwd: localPath }) : null; const push = selected ? run('git', ['remote', 'get-url', '--push', '--all', selected], { cwd: localPath }) : null; const urls = url?.status === 0 ? url.stdout.trim().split(/\r?\n/).filter(Boolean) : []; const pushUrls = push?.status === 0 ? push.stdout.trim().split(/\r?\n/).filter(Boolean) : []; const matchesConfigured = Boolean(merged.repo && (urls.length && pushUrls.length ? [...urls, ...pushUrls].every(value => repositoryIdentity(value) === repositoryIdentity(merged.repo)) : cloneExists && !names.length && resolve(merged.repo) === resolve(localPath)));
  return { status: 'configured', ...merged, localPath, clone: status(cloneExists), rootIndex: { path: rootIndex, status: status(rootIndex && await file(rootIndex)) }, projectBucketIndex: { path: bucketIndex, status: status(bucketIndex && await file(bucketIndex)) }, bucketIndexes, remote: { status: remote ? remote.status === 0 ? status(Boolean(remote.stdout.trim())) : 'unverifiable' : 'absent', names, selected, urls, pushUrls, matchesConfigured } }; }
async function verify(project) {
  const checks = []; const configPath = resolve(project, '.geppetto/config.json'); try { validateConfig(await jsonFile(configPath), configPath); checks.push({ name: 'config', pass: true }); }
  catch (error) { checks.push({ name: 'config', pass: false, reason: error.message }); }
  const agentGate = fileURLToPath(new URL('./gate-agents.mjs', import.meta.url)); const sectionGate = fileURLToPath(new URL('./gate-sections.mjs', import.meta.url)); const temp = await mkdtemp(resolve(tmpdir(), 'geppetto-audit-'));
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
  return checks; }
export async function main(args) {
  const opts = parseArgs(args, { values: ['--project', '--since'], flags: ['--json', '--verify'] });
  if (opts._.length) throw new UsageError('Usage: audit.mjs [--project <dir>] [--json] [--verify]');
  const project = resolve(opts['--project'] ?? '.');
  if (!await directory(project)) throw new Error(`${project}:1: Project directory does not exist`);
  const config = await jsonFile(resolve(project, '.geppetto/config.json'), {}); const machine = await jsonFile(resolve(userHome(), '.geppetto/machine.json'), {});
  validateTurnPolicy(config);
  const turns = await localRecords(project, 'turns');
  const report = { project, dataDirectory: projectDataPath(project, ''), foundations: foundationReport(config), node: { version: process.versions.node, status: Number(process.versions.node.split('.')[0]) >= 22 ? 'present' : 'absent' }, installed: Object.keys((await jsonFile(resolve(project, '.geppetto/install.json'), { installations: {} })).installations), machine, memory: await memoryReport(project), hostLint: await hostLintReport(project, opts['--verify']), learning: learningReadiness(project, config.hooks?.signalLearning) };
  report.turnChecks = turnMetrics(turns);
  report.evidence = await learningAudit(project, { since: opts['--since'] });
  if (opts['--verify']) {
    report.verification = await verify(project);
    if (report.memory.status === 'configured') report.verification.push({ name: 'memory-remote-url', pass: report.memory.remote.matchesConfigured, reason: report.memory.remote.matchesConfigured ? undefined : 'Memory fetch/push remote URL does not equal configured memory.repo' });
    if (report.hostLint.check.status !== 'not-verified') report.verification.push({ name: 'host-affected-file-check', pass: report.hostLint.check.status === 'pass', reason: report.hostLint.check.reason });
  }
  if (opts['--json']) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Geppetto audit: ${project}\nNode ${report.node.version} (minimum 22)`);
    console.log(`Runtime data: ${report.dataDirectory}`);
    console.log(`Installed: ${report.installed.join(', ') || 'run adoption'}`);
    console.log(`Hooks: ${Object.keys(machine.hooks ?? {}).join(', ') || 'run adoption'}`);
    console.log(`Memory: ${report.memory.status}`); console.log(`Unset foundations: ${report.foundations.unset.join(', ') || 'none'}`);
    console.log(`Turn checks: ${report.turnChecks.editedTurns} edited turns; median added ${report.turnChecks.medianAddedSeconds ?? 'unknown'} s; next-message corrections ${report.turnChecks.correctedNextMessage}/${report.turnChecks.classifiedNextMessages} classified, ${report.turnChecks.unclassifiedNextMessages} unknown.`);
    for (const [name, job] of Object.entries(machine.jobs ?? {})) console.log(`Job ${name}: ${job.status}${job.status === 'needs-scheduler' ? '; attach an available scheduler' : ''}`);
    console.log(`Signal learning: ${report.learning.enabled ? 'enabled' : report.learning.action ? 'not ready' : 'disabled'}${report.learning.action ? `; ${report.learning.action}` : ''}`);
    console.log(`Evidence: ${report.evidence.openKeys.length} open keys; ${report.evidence.neverRead.length} pages/skills never read in the window.`);
    for (const outcome of report.evidence.outcomes) console.log(`${outcome.key}: ${outcome.didNotFix ? 'did not fix; reopened' : 'no observed recurrence'}; ${outcome.neverRead.length} changed pages never read${outcome.candidateToRevert ? '; candidate to revert' : ''}`);
    for (const configuration of report.hostLint.configurations) console.log(`Host ${configuration.tool}: ${configuration.path}:1: ${configuration.registration}; ${configuration.patterns.join(', ')}`);
    for (const check of report.verification ?? []) console.log(`${check.pass ? 'PASS' : 'FAIL'} ${check.name}${check.reason ? `: ${check.reason}` : ''}`);
  }
  return report.node.status === 'absent' || report.verification?.some(c => !c.pass) ? 1 : 0; }
if (isMain(import.meta.url)) await cli(main);
