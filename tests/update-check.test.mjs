import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { invoke } from './helpers.mjs';
import { checkUpdate, updateNotice } from '../skills/geppetto-adopt/scripts/update-check.mjs';
import { main } from '../skills/geppetto-adopt/scripts/install.mjs';
import { maintenanceLauncherText, maintenanceJobs } from '../skills/geppetto-adopt/scripts/maintenance.mjs';

test('update diagnosis reads the published version and leaves an unadopted project untouched', async t => {
  const project = await mkdtemp(join(tmpdir(), 'geppetto-update-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const messages = [];
  t.mock.method(console, 'log', message => messages.push(message));
  t.mock.method(globalThis, 'fetch', async url => {
    const upstream = 'https://api.github.com/repos/immagiov4/Geppetto';
    if (String(url) === upstream + '/commits/v99.1.0') return Response.json({ sha: 'a'.repeat(40) });
    assert.equal(String(url), upstream + '/releases/latest');
    return Response.json({ tag_name: 'v99.1.0' });
  });

  await main(['--check-update', '--target', 'agents', '--project', project]);

  assert.match(messages.join('\n'), /99\.1\.0/);
  assert.match(messages.join('\n'), /--target agents.*--gate-sha a{40}/);
  assert.deepEqual(await readdir(project), []);
});

test('startup notices reuse the daily check and retry on the next day', async t => {
  const home = await mkdtemp(join(tmpdir(), 'geppetto-update-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, 'project');
  await mkdir(join(root, '.geppetto'), { recursive: true });
  await writeFile(join(root, '.geppetto', 'install.json'), JSON.stringify({
    source: { version: '0.10.6' },
    installations: { codex: {} },
  }));
  const publish = t.mock.method(globalThis, 'fetch', async url => Response.json(String(url).includes('/commits/') ? { sha: 'a'.repeat(40) } : { tag_name: 'v99.1.0' }));

  assert.match(await updateNotice(root, { home, now: () => 0 }), /99\.1\.0.*--target codex/);
  assert.match(await updateNotice(root, { home, now: () => 1000 }), /99\.1\.0/);
  assert.equal(publish.mock.callCount(), 2);
  assert.match(await updateNotice(root, { home, now: () => 86_400_000 }), /99\.1\.0/);
  assert.equal(publish.mock.callCount(), 4);
});

test('startup reports a half-update even when the installed package version is current', async t => {
  const home = await mkdtemp(join(tmpdir(), 'geppetto-half-update-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, 'project');
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  await mkdir(join(root, '.geppetto'), { recursive: true });
  await writeFile(join(root, '.geppetto', 'install.json'), JSON.stringify({
    source: { path: root, version: metadata.version },
    installations: { codex: {} },
  }));
  t.mock.method(globalThis, 'fetch', async url => Response.json(String(url).includes('/commits/')
    ? { sha: 'a'.repeat(40) }
    : { tag_name: 'v' + metadata.version }));

  assert.match(await updateNotice(root, { home, now: () => 0 }), /--check-update --target codex/);
});

test('an older upstream cache never advertises a downgrade to the running installation', async t => {
  const home = await mkdtemp(join(tmpdir(), 'geppetto-downgrade-notice-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.geppetto'), { recursive: true });
  await writeFile(join(home, '.geppetto', 'install.json'), JSON.stringify({
    source: { version: '0.10.6' }, installations: { claude: {} },
  }));
  await writeFile(join(home, '.geppetto', 'update-status.json'), JSON.stringify({
    epoch: 0, version: '0.0.1', sha: 'a'.repeat(40),
  }));
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('same-day cache should be reused'); });

  const notice = await updateNotice(home, { home, now: () => 0, harness: 'claude' });

  assert.doesNotMatch(notice, /0\.0\.1 is published/);
  assert.match(notice, /repair|incomplete|half-updated/i);
  assert.equal(fetch.mock.callCount(), 0);
});

test('startup chooses the running harness and flags missing Codex approval evidence', async t => {
  const home = await mkdtemp(join(tmpdir(), 'geppetto-startup-trust-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  const geppetto = join(home, '.geppetto');
  await mkdir(join(geppetto, 'bin'), { recursive: true });
  await writeFile(join(geppetto, 'install.json'), JSON.stringify({
    source: { path: home, version }, installations: { claude: {}, codex: {} },
  }));
  await writeFile(join(geppetto, 'machine.json'), JSON.stringify({
    jobs: Object.fromEntries(maintenanceJobs.map(name => [name, { status: 'scheduled-elsewhere' }])),
  }));
  await writeFile(join(geppetto, 'bin', 'maintenance-launcher.mjs'), maintenanceLauncherText(home, { path: home }));
  await writeFile(join(geppetto, 'update-status.json'), JSON.stringify({
    epoch: 0, version, sha: 'a'.repeat(40),
  }));
  assert.equal(await updateNotice(home, { home, now: () => 0, harness: 'claude' }), '');
  assert.match(await updateNotice(home, { home, now: () => 0, harness: 'codex' }),
    /Codex hook trust.*--target codex --user/);
  const day = Math.floor(Date.now() / 86_400_000);
  await writeFile(join(geppetto, 'update-status.json'), JSON.stringify({ epoch: day, version, sha: 'a'.repeat(40) }));
  const event = { cwd: home, session_id: 'direct-hooks', hook_event_name: 'SessionStart' };
  const direct = invoke('hook.mjs', ['--harness', 'codex'], { cwd: home, home, input: JSON.stringify(event) });
  assert.equal(direct.status, 0, direct.stderr);
  assert.match(JSON.parse(direct.stdout).hookSpecificOutput?.additionalContext ?? '', /--target codex --user/);
});

test('update diagnosis distinguishes a stale native task action from a healthy registration', async t => {
  const home = await mkdtemp(join(tmpdir(), 'geppetto-scheduler-drift-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const geppetto = join(home, '.geppetto');
  const manifest = { source: { path: home, version: '99.1.0' }, installations: { claude: {} } };
  await mkdir(join(geppetto, 'bin'), { recursive: true });
  await writeFile(join(geppetto, 'machine.json'), JSON.stringify({
    jobs: Object.fromEntries(maintenanceJobs.map(name => [name, { status: 'scheduled', scheduler: 'windows-task-scheduler' }])),
  }));
  await writeFile(join(geppetto, 'maintenance.vbs'), 'fixture');
  await writeFile(join(geppetto, 'bin', 'maintenance-launcher.mjs'), maintenanceLauncherText(home, manifest.source));
  const messages = [];
  t.mock.method(console, 'log', message => messages.push(message));
  t.mock.method(globalThis, 'fetch', async () => Response.json({ tag_name: 'v99.1.0' }));
  const execute = (program, args) => {
    assert.equal(program, 'schtasks.exe');
    const name = args[2].replace('Geppetto-', '');
    const launcher = join(geppetto, name === 'curate-skills' ? 'stale.vbs' : 'maintenance.vbs');
    return { status: 0, stdout: '<Task><Triggers><CalendarTrigger><StartBoundary>2026-11-21T09:00:00</StartBoundary>' +
      '<ScheduleByWeek><WeeksInterval>1</WeeksInterval><DaysOfWeek><Monday /></DaysOfWeek></ScheduleByWeek>' +
      '</CalendarTrigger></Triggers><Actions Context="Author"><Exec><Command>wscript.exe</Command>' +
      '<Arguments>"' + launcher + '" ' + name + '</Arguments></Exec></Actions></Task>' };
  };
  await checkUpdate({ root: home, target: 'claude', user: true, manifest, shellQuote: JSON.stringify, execute, home });
  assert.match(messages.join('\n'), /curate-skills:.*action differs/);
  assert.doesNotMatch(messages.join('\n'), /maintain-memory:.*action differs/);
});
