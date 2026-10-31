import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { approveCodexHooks } from '../skills/geppetto-adopt/scripts/install.mjs';
import { repo } from './helpers.mjs';
const project = resolve('synthetic-project'), source = { path: repo };
function fixture(hooks, failure = false) {
  const writes = []; let closed = false;
  const client = { initialize: async () => {}, close: async () => { closed = true; }, request: async (method, params) => {
    if (failure) throw new Error('unsupported hooks/list');
    if (method === 'hooks/list') return { data: [{ cwd: project, hooks, errors: [], warnings: [] }] };
    writes.push(...params.edits);
    for (const edit of params.edits) hooks.find(h => edit.keyPath.includes(JSON.stringify(h.key))).trustStatus = 'trusted';
    return { status: 'ok' };
  }};
  return { writes, connect: () => client, closed: () => closed };
}
const hook = (key, extra = {}) => ({ key, currentHash: key, enabled: true, isManaged: false, trustStatus: 'untrusted', sourcePath: resolve('home/.codex/hooks.json'), command: key, ...extra });
test('installer approves owned user keys, preserves shared-file hooks and retries idempotently', async () => {
  const hooks = [hook('owned'), hook('foreign')], f = fixture(hooks), installed = { source: hooks[0].sourcePath, commands: ['owned'] };
  assert.equal(await approveCodexHooks(project, source, installed, f.connect), 0);
  assert.equal(hooks[1].trustStatus, 'untrusted'); assert.equal(f.writes.length, 1);
  assert.equal(await approveCodexHooks(project, source, installed, f.connect), 0); assert.equal(f.writes.length, 1); assert.ok(f.closed());
});

test('Windows user hook ownership ignores path capitalization', { skip: process.platform !== 'win32' }, async () => {
  const hooks = [hook('owned')], f = fixture(hooks);
  const installed = { source: hooks[0].sourcePath.toUpperCase(), commands: ['owned'] };
  assert.equal(await approveCodexHooks(project, source, installed, f.connect), 0);
  assert.equal(f.writes.length, 1);
});
test('missing, ambiguous, namesake and unsupported plugin inventories approve nothing', async () => {
  for (const hooks of [[], [hook('a', {pluginId:'geppetto@one'}),hook('b', {pluginId:'geppetto@two'})], [hook('a', {pluginId:'geppetto@foreign'})]]) {
    const f = fixture(hooks); assert.equal(await approveCodexHooks(project, source, {source:'plugin'}, f.connect), 1); assert.equal(f.writes.length, 0);
  }
  const f = fixture([], true); assert.equal(await approveCodexHooks(project, source, {source:'plugin'}, f.connect), 1); assert.equal(f.writes.length, 0);
});
test('matching plugin content is approved again after its inventory hash changes', async () => {
  const hooks = [hook('owned', {pluginId:'geppetto@local',sourcePath:resolve(repo,'hooks/hooks.json')})], f = fixture(hooks);
  assert.equal(await approveCodexHooks(project, source, {source:'plugin'}, f.connect), 0);
  hooks[0].currentHash = 'updated'; hooks[0].trustStatus = 'modified';
  assert.equal(await approveCodexHooks(project, source, {source:'plugin'}, f.connect), 0); assert.equal(f.writes.at(-1).value, 'updated');
});

test('plugin content changed after scope verification is not approved', async () => {
  const hooks = [hook('owned', {pluginId:'geppetto@local',sourcePath:resolve(repo,'hooks/hooks.json')})], f = fixture(hooks), client = f.connect();
  const request = client.request; let lists = 0;
  client.request = async (method, params) => { if (method === 'hooks/list' && ++lists === 2) hooks[0].currentHash = 'changed-after-verification'; return request(method, params); };
  assert.equal(await approveCodexHooks(project, source, {source:'plugin'}, () => client), 1); assert.equal(f.writes.length, 0);
});

test('user command replaced after ownership selection is not approved', async () => {
  const hooks = [hook('owned')], f = fixture(hooks), client = f.connect();
  const request = client.request; let lists = 0;
  client.request = async (method, params) => {
    if (method === 'hooks/list' && ++lists === 2) { hooks[0].command = 'foreign'; hooks[0].currentHash = 'foreign-command'; }
    return request(method, params);
  };
  assert.equal(await approveCodexHooks(project, source, { source: hooks[0].sourcePath, commands: ['owned'] }, () => client), 1);
  assert.equal(f.writes.length, 0);
});

test('Git line endings do not make an unchanged plugin payload foreign', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'geppetto-hook-eol-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorized = resolve(root, 'source'), cached = resolve(root, 'cache');
  for (const path of [authorized, cached]) {
    for (const dir of ['hooks', 'skills', 'scripts', '.codex-plugin']) await mkdir(resolve(path, dir), { recursive: true });
    await writeFile(resolve(path, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'geppetto', version: '0.8.0' }));
    await writeFile(resolve(path, 'hooks/hooks.json'), '{}');
    await writeFile(resolve(path, 'scripts/entry.mjs'), `export const enabled = true;${path === authorized ? '\r\n' : '\n'}`);
  }
  const hooks = [hook('owned', { pluginId: 'geppetto@local', sourcePath: resolve(cached, 'hooks/hooks.json') })], f = fixture(hooks);
  assert.equal(await approveCodexHooks(project, { path: authorized }, { source: 'plugin' }, f.connect), 0);
  assert.equal(f.writes.length, 1);
  await writeFile(resolve(cached, 'scripts/entry.mjs'), 'export const enabled = false;\n');
  assert.equal(await approveCodexHooks(project, { path: authorized }, { source: 'plugin' }, f.connect), 1);
  assert.equal(f.writes.length, 1);
});
