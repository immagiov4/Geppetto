import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { updateNotice } from '../skills/geppetto-adopt/scripts/update-check.mjs';
import { main } from '../skills/geppetto-adopt/scripts/install.mjs';

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
