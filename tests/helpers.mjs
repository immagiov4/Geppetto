import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, dirname, basename, delimiter } from 'node:path';
import { reviewMaterialSeal } from '../skills/geppetto-adopt/scripts/review-evidence.mjs';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const scripts = resolve(repo, 'skills/geppetto-adopt/scripts');
export function fixture(t, cleanup = {}) {
  const dir = realpathSync.native(mkdtempSync(resolve(tmpdir(), 'geppetto-test-')));
  t.after(() => rm(dir, { recursive: true, force: true, ...cleanup }));
  return dir;
}
export function put(dir, path, text) { mkdirSync(dirname(resolve(dir, path)), { recursive: true }); writeFileSync(resolve(dir, path), typeof text === 'string' ? text : JSON.stringify(text)); }
/** Preserve Node's case-insensitive Windows environment object. */
export function restoreEnv(snapshot) {
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(snapshot, key)) delete process.env[key];
  Object.assign(process.env, snapshot);
}
export const get = (dir, path) => readFileSync(resolve(dir, path), 'utf8');
export function invoke(script, args = [], { cwd = repo, home = cwd, input = '', env = {}, memoryChoice } = {}) {
  // Installation fixtures use a fake native scheduler, never the host's real jobs.
  const temporary = basename(script) === 'install.mjs' ? mkdtempSync(resolve(tmpdir(), 'geppetto-scheduler-')) : null;
  try {
    if (basename(script) === 'install.mjs' && !args.includes('--memory')) {
      if (memoryChoice === undefined) {
        const configured = [home, cwd].some(root => {
          try { const memory = JSON.parse(get(root, '.geppetto/config.json')).memory; return memory?.choice || memory?.repo || memory?.localPath; }
          catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
        });
        if (!configured) memoryChoice = 'none';
      }
      if (memoryChoice) args = [...args, '--memory', memoryChoice];
    }
    if (temporary) {
      const jobs = Object.fromEntries(['curate-skills', 'maintain-memory'].map(name => [name, { scheduler: 'fixture', id: name, cadence: 'weekly', nextRun: '2026-11-02T09:00:00', disable: `fixture disable ${name}`, ...(args.includes('--uninstall') ? { status: 'disabled' } : {}) }]));
      if (!args.includes('--scheduler-jobs')) { put(temporary, 'jobs.json', jobs); args = [...args, '--scheduler-jobs', resolve(temporary, 'jobs.json')]; }
      for (const [pkg, script] of [['@openai/codex', 'codex.js'], ['@anthropic-ai/claude-code', 'cli.js']]) put(temporary, `node_modules/${pkg}/bin/${script}`, "console.log('[]');");
    }
    if (temporary) put(temporary, 'node_modules/@openai/codex/bin/codex.js', `
const fs = require('node:fs'), path = require('node:path'), rl = require('node:readline');
if (process.env.INSTALL_TRUST_LOG && process.argv.includes('app-server')) fs.appendFileSync(process.env.INSTALL_TRUST_LOG,'app-server\\n');
if (!process.argv.includes('app-server')) { console.log('[]'); process.exit(0); }
let hooks;
rl.createInterface({input:process.stdin}).on('line', line => {
  const q=JSON.parse(line); if(q.id===undefined)return; let result={};
  if(process.env.INSTALL_TRUST_UNSUPPORTED && q.method==='hooks/list') { console.log(JSON.stringify({id:q.id,error:{message:'unsupported hooks/list'}})); return; }
  if(q.method==='hooks/list') {
    if(!hooks) {
      const machine=JSON.parse(fs.readFileSync(path.resolve(process.env.HOME,'.geppetto/machine.json')));
      const installed=machine.hooks.codex, source=Object.values(machine.projects[q.params.cwds[0]])[0];
      const sourcePath=installed.source==='plugin'?path.resolve(source,'hooks/hooks.json'):installed.source;
      const definitions=JSON.parse(fs.readFileSync(sourcePath));
      hooks=Object.entries(definitions.hooks).flatMap(([event,groups])=>groups.flatMap((g,i)=>g.hooks.map((h,j)=>({key:sourcePath+':'+event+':'+i+':'+j,currentHash:'fixture-hash',enabled:true,isManaged:false,trustStatus:'untrusted',sourcePath,command:h.command,pluginId:installed.source==='plugin'?'geppetto@fixture':null}))));
    }
    result={data:[{cwd:q.params.cwds[0],hooks,errors:[],warnings:[]}]};
  }
  if(q.method==='config/batchWrite') { for(const edit of q.params.edits){const key=JSON.parse(edit.keyPath.slice('hooks.state.'.length,-'.trusted_hash'.length));hooks.find(h=>h.key===key).trustStatus='trusted';} result={status:'ok'}; }
  console.log(JSON.stringify({id:q.id,result}));
});`);
    return spawnSync(process.execPath, [resolve(scripts, script), ...args], { cwd, input, encoding: 'utf8', windowsHide: true, env: { ...process.env, HOME: home, USERPROFILE: home, OPENROUTER_API_KEY: '', CODEX_HOME: resolve(home, '.codex'), ...(temporary ? { PATH: `${temporary}${delimiter}${process.env.PATH}` } : {}), ...env } });
  } finally { if (temporary) rmSync(temporary, { recursive: true, force: true }); }
}
export function parallel(script, args, { cwd, home = cwd }) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve(scripts, script), ...args], { cwd, windowsHide: true, env: { ...process.env, HOME: home, USERPROFILE: home } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject); child.on('close', status => resolveResult({ status, stdout, stderr }));
  });
}
export function git(dir, args, options = {}) { return spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, ...options }); }

/** Fake runner artifacts for hook tests; these fixtures do not invoke a model. */
export function reviewFixture(t, root, outcome = 'passed', base = 'HEAD', nativeHome, { strategy = 'questions', profile = 'standard', stages, candidates, findings, shardCount, verifyStages, verifyResponses = {}, archivedStages = {}, archivedShards = {} } = {}) {
  const directory = fixture(t);
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const patch = git(root, ['diff', '--binary', '--no-ext-diff', base, '--'], { maxBuffer: 8 * 1024 * 1024 }).stdout;
  const paths = new Set([
    ...git(root, ['diff', '--name-only', '--no-renames', '-z', base, '--']).stdout.split('\0'),
    ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']).stdout.split('\0'),
  ].filter(path => path && !path.startsWith('.geppetto/')));
  const hashes = { 'diff.patch': sha(patch) };
  for (const path of paths) {
    try { hashes['after/' + path] = sha(readFileSync(resolve(root, path))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  findings ??= outcome === 'findings' ? [{ id: 'fixture' }] : [];
  const lenses = shardCount >= 2
    ? [...Array.from({ length: shardCount }, (_, i) => 'shard-' + (i + 1)),
      ...(profile === 'ultra' ? ['gap-seams', 'gap-rules-tests'] : ['gap-audit'])]
    : ['lens-correctness', 'lens-rules-tests',
      ...(profile === 'ultra' ? ['gap-logic', 'gap-contracts-docs'] : ['gap-audit'])];
  const discovery = strategy === 'lenses' ? lenses
    : strategy === 'generic' ? ['search-1', 'search-2'] : ['questions', 'investigate'];
  candidates ??= findings;
  verifyStages ??= candidates.length ? ['verify'] : [];
  stages ??= [...discovery, ...verifyStages];
  const batchBoundary = Math.ceil(candidates.length / 2);
  const batchFor = stage => stage === 'verify' ? candidates
    : stage === 'verify-1' ? candidates.slice(0, batchBoundary) : candidates.slice(batchBoundary);
  const verification = stage => {
    if (stage === 'verify' && strategy !== 'lenses') return { accepted_findings: findings };
    const batch = batchFor(stage);
    const accepted_findings = findings.filter(finding => batch.some(candidate => candidate.id === finding.id));
    return { accepted_findings, decisions: batch.map(({ id }) => accepted_findings.some(finding => finding.id === id)
      ? { id, decision: 'accept', canonical_id: id }
      : { id, decision: 'reject', canonical_id: '-' }) };
  };
  const threads = stages.map(() => randomUUID());
  const started = Date.now();
  const day = new Date(started).toISOString().slice(0, 10).replaceAll('-', '/');
  const calls = stages.map((stage, index) => {
    const response = JSON.stringify(stage.startsWith('verify') ? verifyResponses[stage] ?? verification(stage)
      : stage === 'investigate' ? { report: { findings: candidates } }
        : stage === 'questions' ? { questions: [] } : { findings: index === 0 ? candidates : [] });
    put(directory, stage + '.json', response);
    const events = [
      { type: 'thread.started', thread_id: threads[index] },
      { type: 'turn.completed', usage: { output_tokens: 30 } },
    ];
    put(directory, stage + '.events.jsonl', events.map(JSON.stringify).join('\n'));
    const prompt = ['Review fixture begins', 'Review material SHA-256: ' + reviewMaterialSeal(hashes)];
    if (stage === 'verify-1' || stage === 'verify-2') {
      prompt.unshift('Review candidate IDs: ' + JSON.stringify(batchFor(stage).map(({ id }) => id).sort()));
    }
    if (strategy === 'lenses') prompt.push('Review stage: ' + (archivedStages[stage] ?? stage));
    if (strategy === 'lenses' && shardCount >= 2) prompt.push('Review shards: ' + (archivedShards[stage] ?? shardCount));
    prompt.push('Review fixture ends');
    put(nativeHome ?? resolve(directory, '.codex'), 'sessions/' + day + '/rollout-fixture-' + threads[index] + '.jsonl', [
      { type: 'session_meta', payload: { id: threads[index] } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'review' } },
      { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: prompt.join('\r\n') }] } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'review', last_agent_message: response } },
    ].map(JSON.stringify).join('\n'));
    return { stage, status: 'completed', started_at: started / 1000, exit_code: 0, response_sha256: sha(response) };
  });
  put(directory, 'findings.json', { findings });
  const sharding = shardCount === undefined ? {} : { shard_count: shardCount,
    shards: Array.from({ length: shardCount }, (_, i) => ({ index: i + 1 })) };
  put(directory, 'metrics.json', { ...sharding, status: 'complete', strategy, ...(strategy === 'lenses' ? { profile } : {}), changed_paths: [...paths],
    case_fingerprint: hashes, calls, thread_ids: threads });
  return directory;
}

export function invokeReview(t, root, outcome, session, turn, nativeHome, evidence = reviewFixture(t, root, outcome, 'HEAD', nativeHome)) {
  const args = ['--record-review', '--base', 'HEAD', '--outcome', outcome, '--evidence', evidence];
  if (session) args.push('--session', session, '--turn', turn);
  return invoke('hook.mjs', args, { cwd: root, env: { CODEX_HOME: resolve(evidence, '.codex') } });
}

export const config = () => ({ version: 1, docs: { root: 'docs', style: 'project', referenceRepo: null }, sections: { pr: ['Observability'], featureDocs: ['Observability'], optional: ['Verification'] }, review: { engine: 'code-review' }, unitCoverage: 'behaviour', packs: [], pillars: {}, hooks: {} });
