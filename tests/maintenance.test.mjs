import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delimiter, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { rmSync, existsSync, cpSync } from 'node:fs';
import { fixture, get, put, repo, invoke, restoreEnv, git } from './helpers.mjs';
import { reconcileMachine } from '../skills/geppetto-adopt/scripts/machine.mjs';
import { scheduleMaintenance, disableMaintenance } from '../skills/geppetto-adopt/scripts/maintenance.mjs';

for (const host of ['claude', 'codex']) test(`${host} jobs run after the installed plugin cache is deleted without re-registration`, async t => {
  const home = isolatedMachine(t), project = fixture(t);
  const cache = resolve(home, host, 'plugins/cache/geppetto/geppetto');
  const oldSource = resolve(cache, '0.3.1'), newSource = resolve(cache, '0.10.0');
  const installPackage = (path, version) => {
    cpSync(resolve(repo, 'skills'), resolve(path, 'skills'), { recursive: true });
    put(path, 'package.json', { name: 'geppetto', version, type: 'module' });
  };
  installPackage(oldSource, '0.3.1');
  await reconcileMachine(project, host, { path: oldSource, version: '0.3.1' }, {
    home, pluginHooks: true,
    scheduler: async name => ({ id: `Geppetto-${name}`, status: 'scheduled', host }),
  });
  const registered = get(home, '.geppetto/machine.json');
  installPackage(newSource, '0.10.0');
  installPackage(resolve(cache, '0.9.9'), '0.9.9');
  // An interrupted update must not hide the newest complete installed package.
  put(resolve(cache, '0.11.0'), 'package.json', { name: 'geppetto', version: '0.11.0' });
  rmSync(oldSource, { recursive: true, force: true });
  const launcher = resolve(home, '.geppetto/bin/maintenance-launcher.mjs');
  for (const name of ['curate-skills', 'maintain-memory']) {
    const result = spawnSync(process.execPath, [launcher, '--run', name, '--dry-run'], {
      encoding: 'utf8', windowsHide: true, env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.source, resolve(newSource, `skills/geppetto-adopt/assets/templates/jobs/${name}.md`));
    assert.equal(plan.host, name === 'maintain-memory' ? 'codex' : host);
    if (name === 'curate-skills') assert.deepEqual(plan.roots, [project, newSource]);
  }
  assert.equal(get(home, '.geppetto/machine.json'), registered);
  rmSync(cache, { recursive: true, force: true });
  const missing = spawnSync(process.execPath, [launcher, '--run', 'curate-skills', '--dry-run'], { encoding: 'utf8', windowsHide: true });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No installed Geppetto maintenance package/);
});

function isolatedMachine(t) {
  const home = fixture(t), original = { ...process.env };
  // Keep a broken injection from reaching the real registry or scheduler during red tests.
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.PATH = '';
  t.after(() => restoreEnv(original));
  return home;
}

test('Windows scheduling reuses or registers a hidden weekly task and records its next run', async t => {
  const home = fixture(t), calls = [];
  const execute = (binary, args) => {
    calls.push({ binary, args });
    if (!args.includes('-EncodedCommand')) return { status: 0 };
    const code = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.match(code, /Get-ScheduledTask/); assert.match(code, /Register-ScheduledTask/); assert.match(code, /-Hidden/); assert.match(code, /-Weekly -DaysOfWeek Monday -At '09:00'/);
    assert.match(code, /wscript.exe/); assert.match(code, /NextRunTime/);
    return { status: 0, stdout: JSON.stringify({ id: 'Geppetto-curate-skills', nextRun: '2026-11-02T09:00:00' }) };
  };
  const job = await scheduleMaintenance('curate-skills', { home, host: 'codex', source: { path: repo }, platform: 'win32', execute, command: { executable: 'fake-codex' } });
  assert.equal(job.id, 'Geppetto-curate-skills'); assert.equal(job.nextRun, '2026-11-02T09:00:00'); assert.match(job.disable, /DISABLE/);
  const launcher = get(home, '.geppetto/maintenance.vbs');
  assert.match(launcher, /WScript.Quit/); assert.match(launcher, /, 0, True/); assert.match(launcher, /--run/); assert.match(launcher, /"".*node/);
  assert.equal(calls.length, 2);
  await assert.rejects(scheduleMaintenance('curate-skills', { home, host: 'codex', source: { path: repo }, platform: 'win32', command: {}, execute: (_binary, args) => args.includes('-EncodedCommand') ? { status: 1, stderr: 'fixture registration failure' } : { status: 0 } }), /registration failure/);
});


test('a disabled owned Windows task is repaired and verified before enabling', async t => {
  const home = fixture(t), mutations = [];
  const name = 'curate-skills';
  let disabled = true, valid = false;
  const execute = (program, args) => {
    if (program === 'schtasks.exe') return { status: 0, stdout:
      '<Task><Triggers><CalendarTrigger><StartBoundary>2026-11-21T09:00:00</StartBoundary>' +
      '<ScheduleByWeek><WeeksInterval>1</WeeksInterval><DaysOfWeek><Monday /></DaysOfWeek></ScheduleByWeek>' +
      '</CalendarTrigger></Triggers><Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>"' +
      resolve(home, '.geppetto/' + (valid ? 'maintenance.vbs' : 'stale.vbs')) + '" ' + name +
      '</Arguments></Exec></Actions>' + (disabled ? '<Settings><Enabled>false</Enabled></Settings>' : '') + '</Task>' };
    if (!args.includes('-EncodedCommand')) return { status: 0 };
    const ps = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    if (ps.includes('Set-ScheduledTask -TaskName')) { mutations.push('repaired'); valid = true; }
    if (ps.includes("'true' -eq 'true') { Enable-ScheduledTask")) {
      assert.ok(valid, 'activation would launch an unverified task');
      mutations.push('enabled');
      disabled = false;
    }
    return { status: 0, stdout: JSON.stringify({ id: 'Geppetto-' + name, nextRun: '2026-11-23T09:00:00' }) };
  };
  const job = await scheduleMaintenance(name, { home, host: 'codex', source: { path: repo }, platform: 'win32', execute,
    command: {}, previous: { id: 'Geppetto-' + name, scheduler: 'windows-task-scheduler' } });
  assert.equal(job.status, 'scheduled');
  assert.deepEqual(mutations, ['repaired', 'enabled']);
});

test('cron attachment preserves unrelated entries and reuses its own job without duplication', async t => {
  const home = fixture(t); let cron = '0 12 * * * echo unrelated\n', writes = 0;
  const execute = (_binary, args, options) => {
    if (args[0] === '-l') return { status: 0, stdout: cron };
    writes++; cron = options.input; return { status: 0 };
  };
  const options = { home, host: 'claude', source: { path: repo }, platform: 'linux', execute, command: {} };
  for (let i = 0; i < 2; i++) {
    const job = await scheduleMaintenance('maintain-memory', options);
    assert.equal(job.status, 'scheduled'); assert.ok(Date.parse(job.nextRun) > Date.now());
    assert.equal(new Date(job.nextRun).getDay(), 1); assert.equal(new Date(job.nextRun).getHours(), 9);
  }
  assert.equal(writes, 1); assert.match(cron, /echo unrelated/); assert.match(cron, /0 9 \* \* 1.*--run maintain-memory/);
  assert.equal(await scheduleMaintenance('maintain-memory', { ...options, execute: () => ({ error: { code: 'ENOENT' } }) }), null);
});

test('Windows hidden launcher propagates the actual child exit status', { skip: process.platform !== 'win32' }, async t => {
  const home = fixture(t), source = { path: fixture(t) };
  put(source.path, 'skills/geppetto-adopt/scripts/maintenance.mjs', 'export async function main() { return 7; }');
  put(source.path, 'skills/geppetto-adopt/scripts/common.mjs', 'export async function cli(main) { process.exitCode = await main(); }');
  await scheduleMaintenance('curate-skills', { home, host: 'codex', source, platform: 'win32', command: {}, execute: (_binary, args) => ({ status: 0, stdout: args.includes('-EncodedCommand') ? '{"id":"fixture","nextRun":"2026-11-02T09:00:00"}' : '' }) });
  const result = spawnSync('cscript.exe', ['//B', '//Nologo', resolve(home, '.geppetto/maintenance.vbs'), 'curate-skills'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 7, result.stderr);
});

test('the scheduled job exchanges JSON with isolated subscription CLI contexts', t => {
  const home = fixture(t), memory = fixture(t);
  put(memory, 'index.md', '# Memory\n\n- [Sample](buckets/sample/index.md)\n');
  put(memory, 'buckets/sample/index.md', '# Sample\n\n- [Page](page.md)\n');
  put(memory, 'buckets/sample/page.md', '# Page\n\nPreserve the exception.\n\nSource: https://example.test/evidence\n');
  assert.equal(git(memory, ['init']).status, 0);
  assert.equal(git(memory, ['add', '.']).status, 0);
  assert.equal(git(memory, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Fixture']).status, 0);
  put(home, '.codex/auth.json', { fake: true });
  put(home, '.codex/AGENTS.md', 'Never enters the job');
  put(home, '.codex/plugins/example/manifest.json', {});
  put(home, 'node_modules/@openai/codex/bin/codex.js', "const fs=require('node:fs'); let raw='';\nprocess.stdin.on('data', data => raw+=data);\nprocess.stdin.on('end', () => {\n  const input=JSON.parse(raw), profile=process.env.CODEX_HOME;\n  fs.appendFileSync(process.env.GEPPETTO_TEST_PROOF,JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),profile,contents:fs.readdirSync(profile).sort(),key:process.env.OPENAI_API_KEY,child:process.env.GEPPETTO_LEARNING_CHILD})+'\\n');\n  const output = input.items ? {items:input.items.map(item => item.path.endsWith('/page.md') ? {\n    id:item.id, status:'rewrite', newText:item.blocks.map(block=>block.text).join('\\n\\n').replace('Preserve the exception.','Preserve the documented exception.')+'\\n',\n    claims:item.blocks.map(block=>({blockId:block.id,claim:block.text,status:'preserved',evidenceIds:[]})),behaviorChange:'No change.'\n  }:{id:item.id,status:'unchanged'})} : {verdicts:input.ops.map(op=>({id:op.id,verdict:'approve',reason:'Exception preserved.'}))};\n  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(output)}}));\n  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:20,output_tokens:10}}));\n});");
  put(home, '.geppetto/machine.json', { memory: { localPath: memory }, jobs: { 'maintain-memory': { status: 'scheduled', host: 'claude' } } });
  const result = invoke('maintenance.mjs', ['--run', 'maintain-memory'], { cwd: home, home, env: { PATH: home + delimiter + process.env.PATH, OPENAI_API_KEY: 'synthetic-secret', GEPPETTO_TEST_PROOF: resolve(home, 'maintenance-proof.jsonl') } });
  assert.equal(result.status, 0, result.stderr + get(home, '.geppetto/maintain-memory.log'));
  const proof = get(home, 'maintenance-proof.jsonl').trim().split('\n').map(JSON.parse);
  assert.equal(proof.length, 2);
  assert.notEqual(proof[0].profile, proof[1].profile);
  for (const row of proof) {
    assert.notEqual(row.cwd, memory);
    assert.equal(row.key, undefined);
    assert.equal(row.child, '1');
    assert.deepEqual(row.contents, ['auth.json', 'config.toml']);
    assert.ok(row.args.includes('exec'));
    assert.ok(row.args.every(arg => !/--model|service_tier/.test(arg)));
    assert.ok(row.args.includes('features.shell_tool=false'));
    assert.ok(row.args.includes('read-only'));
    assert.ok(row.args.includes('mcp_servers={}'));
    assert.equal(existsSync(row.profile), false);
  }
  assert.match(get(memory, 'buckets/sample/page.md'), /Preserve the documented exception/);
  assert.match(get(home, '.geppetto/maintain-memory.log'), /"outcome":"done"/);
});

test('uninstall disables only owned OS jobs and requires external confirmation', async () => {
  let cron = '0 12 * * * echo unrelated\n0 9 * * 1 node owned # Geppetto-maintain-memory\n';
  const execute = (_command, args, options) => {
    if (args[0] === '-l') return { status: 0, stdout: cron };
    cron = options.input; return { status: 0 };
  };
  assert.equal(await disableMaintenance('maintain-memory', { scheduler: 'cron' }, { execute }), true);
  assert.match(cron, /echo unrelated/); assert.doesNotMatch(cron, /Geppetto-maintain-memory/);
  const calls = [];
  assert.equal(await disableMaintenance('curate-skills', { scheduler: 'windows-task-scheduler', id: 'Geppetto-curate-skills' }, { execute: (command, args) => { calls.push([command, ...args]); return { status: 0 }; } }), true);
  assert.deepEqual(calls, [['schtasks.exe', '/Change', '/TN', 'Geppetto-curate-skills', '/DISABLE']]);
  assert.equal(await disableMaintenance('maintain-memory', { scheduler: 'native' }), false);
  assert.equal(await disableMaintenance('maintain-memory', { scheduler: 'native', status: 'disabled' }), true);
});

test('inactive maintenance registrations never launch a model or read its prompt', t => {
  const home = fixture(t);
  for (const status of ['disabled', 'needs-disable', 'starting', 'scheduled-elsewhere']) {
    put(home, '.geppetto/machine.json', { projects: {}, jobs: { 'maintain-memory': { status, source: 'nonexistent-prompt.md' } } });
    const result = invoke('maintenance.mjs', ['--run', 'maintain-memory'], { cwd: home, home, env: { PATH: home } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(resolve(home, '.geppetto/maintain-memory.log')), false);
  }
});

test('maintenance attaches once per machine through the supplied scheduler and preserves native identities', async t => {
  const home = isolatedMachine(t), a = fixture(t), b = fixture(t); const calls = [];
  const scheduler = async name => {
    calls.push(name);
    return { scheduler: 'fake', id: `fake/${name}`, cadence: 'weekly Monday 09:00', nextRun: '2026-11-02T09:00:00', disable: `fake disable ${name}`, status: 'scheduled' };
  };
  for (const project of [a, b, a]) await reconcileMachine(project, 'claude', { path: repo }, { home, pluginHooks: true, scheduler });
  assert.deepEqual(calls, ['curate-skills', 'maintain-memory']);
  const machine = JSON.parse(get(home, '.geppetto/machine.json'));
  assert.equal(machine.jobs['curate-skills'].id, 'fake/curate-skills'); assert.equal(Object.keys(machine.projects).length, 2);
  machine.jobs['maintain-memory'].scheduler = 'native'; put(home, '.geppetto/machine.json', machine);
  await reconcileMachine(b, 'codex', { path: repo }, { home, pluginHooks: true, scheduler: () => assert.fail('existing jobs must be reused') });
  assert.equal(JSON.parse(get(home, '.geppetto/machine.json')).jobs['maintain-memory'].scheduler, 'native');
});

test('scheduler errors remain retryable and missing schedulers alone produce a skip', async t => {
  const home = isolatedMachine(t), project = fixture(t);
  const options = { home, pluginHooks: true, scheduler: async () => { throw new Error('fixture scheduler rejected registration'); } };
  await assert.rejects(reconcileMachine(project, 'codex', { path: repo }, options), /scheduler rejected/);
  await reconcileMachine(project, 'codex', { path: repo }, { ...options, scheduler: async () => null });
  assert.equal(JSON.parse(get(home, '.geppetto/machine.json')).jobs['curate-skills'].status, 'needs-scheduler');
});

test('native scheduler handoff is recorded before OS fallback', t => {
  const home = fixture(t), project = fixture(t);
  const jobs = Object.fromEntries(['curate-skills', 'maintain-memory'].map(name => [name, { scheduler: 'native', id: name, cadence: 'weekly', nextRun: '2026-11-02T09:00:00', disable: `native disable ${name}` }]));
  put(home, 'jobs.json', jobs);
  const result = invoke('install.mjs', ['--target', 'codex', '--project', project, '--plugin-hooks', '--scheduler-jobs', resolve(home, 'jobs.json')], { cwd: project, home });
  assert.equal(result.status, 0, result.stderr);
  const machine = JSON.parse(get(home, '.geppetto/machine.json'));
  for (const name of Object.keys(jobs)) { assert.equal(machine.jobs[name].id, jobs[name].id); assert.equal(machine.jobs[name].status, 'scheduled'); }
});

for (const platform of ['win32', 'linux']) test(`${platform} maintenance launcher survives plugin upgrades and reconciles existing jobs in place`, async t => {
  const home = isolatedMachine(t), project = fixture(t), oldSource = fixture(t), newSource = fixture(t);
  put(oldSource, 'skills/geppetto-adopt/scripts/maintenance.mjs', 'export async function main() { return 7; }');
  put(newSource, 'skills/geppetto-adopt/scripts/maintenance.mjs', 'export async function main() { return 9; }');
  for (const source of [oldSource, newSource]) put(source, 'skills/geppetto-adopt/scripts/common.mjs', 'export async function cli(main) { process.exitCode = await main(process.argv.slice(2)); }');
  let cron = '0 12 * * * echo unrelated\n', registrations = 0;
  const windowsTasks = new Set();
  const scheduler = (name, options) => scheduleMaintenance(name, { ...options, platform, command: {}, execute: (_binary, args, opts) => {
    if (platform === 'linux') {
      if (args[0] === '-l') return { status: 0, stdout: cron };
      cron = opts.input; return { status: 0 };
    }
    if (_binary === 'schtasks.exe') {
      if (!windowsTasks.has(args[2])) return { status: 1 };
      return { status: 0, stdout: '<Task><Triggers><CalendarTrigger><StartBoundary>2026-11-21T09:00:00</StartBoundary>' +
        '<ScheduleByWeek><WeeksInterval>1</WeeksInterval><DaysOfWeek><Monday /></DaysOfWeek></ScheduleByWeek>' +
        '</CalendarTrigger></Triggers><Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>"' +
        resolve(home, '.geppetto/maintenance.vbs') + '" ' + name + '</Arguments></Exec></Actions></Task>' };
    }
    if (!args.includes('-EncodedCommand')) return { status: 0 };
    const id = `Geppetto-${name}`; windowsTasks.add(id); registrations++;
    return { status: 0, stdout: JSON.stringify({ id, nextRun: '2026-11-02T09:00:00' }) };
  } });
  await reconcileMachine(project, 'codex', { path: oldSource }, { home, pluginHooks: true, scheduler });
  if (platform === 'linux') {
    // Simulate an owned action pointing into a disposable plugin cache.
    cron = cron.replaceAll(resolve(home, '.geppetto/bin/maintenance-launcher.mjs'), resolve(oldSource, 'skills/geppetto-adopt/scripts/maintenance.mjs'));
    cron = cron.replace('0 9 * * 1', '15 8 * * 2');
  }
  await reconcileMachine(project, 'codex', { path: newSource }, { home, pluginHooks: true, scheduler });
  await reconcileMachine(project, 'codex', { path: newSource }, { home, pluginHooks: true, scheduler });
  rmSync(oldSource, { recursive: true, force: true });
  const launcher = resolve(home, '.geppetto/bin/maintenance-launcher.mjs');
  const result = spawnSync(process.execPath, [launcher, '--run', 'curate-skills'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 9, result.stderr);
  const machine = JSON.parse(get(home, '.geppetto/machine.json'));
  for (const name of ['curate-skills', 'maintain-memory']) {
    assert.equal(machine.jobs[name].id, `Geppetto-${name}`);
    assert.equal(machine.jobs[name].source, `skills/geppetto-adopt/assets/templates/jobs/${name}.md`);
  }
  if (platform === 'win32') {
    assert.equal(windowsTasks.size, 2); assert.equal(registrations, 6);
    assert.ok(get(home, '.geppetto/maintenance.vbs').includes(launcher));
  } else {
    assert.equal(cron.split('\n').filter(line => line.includes('# Geppetto-')).length, 2);
    assert.ok(cron.includes(launcher)); assert.ok(!cron.includes(oldSource)); assert.match(cron, /echo unrelated/);
    assert.equal(machine.jobs['curate-skills'].cadence, '15 8 * * 2');
  }
});
