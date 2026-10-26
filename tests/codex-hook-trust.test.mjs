import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { connectCodex } from '../skills/geppetto-adopt/scripts/codex-hook-trust.mjs';

const script = resolve('skills/geppetto-adopt/scripts/codex-hook-trust.mjs');
function fixture(t, changes = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'geppetto-trust-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = resolve(root, 'bin/node_modules/@openai/codex/bin/codex.js');
  mkdirSync(resolve(entry, '..'), { recursive: true });
  const hook = (key, extra = {}) => ({ key, currentHash: `sha256:${key}`, enabled: true, isManaged: false, trustStatus: 'untrusted', pluginId: 'geppetto@geppetto', sourcePath: resolve(root, 'hooks.json'), eventName: 'userPromptSubmit', command: `echo ${key}`, ...extra });
  const state = { hooks: [hook('wanted'), hook('other', { pluginId: 'other@other' }), hook('disabled', { enabled: false }), hook('managed', { isManaged: true, trustStatus: 'managed' })], edits: [], unrelated: 'preserved', lists: 0, ...changes };
  const statePath = resolve(root, 'state.json');
  writeFileSync(statePath, JSON.stringify(state));
  writeFileSync(entry, `const fs=require('node:fs'),readline=require('node:readline');
const file=process.env.TRUST_FIXTURE;let state=JSON.parse(fs.readFileSync(file));
readline.createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;let result={};
if(q.method==='hooks/list'){state.lists++;if(state.changeOnRecheck&&state.lists===2)state.hooks[0].currentHash='sha256:changed';result={data:[{cwd:q.params.cwds[0],hooks:state.hooks,errors:state.discoveryError?[{path:'hooks.json',message:'bad hook'}]:[],warnings:['fixture warning']}]};}
if(q.method==='config/batchWrite'){state.edits.push(...q.params.edits);for(const edit of q.params.edits){const key=JSON.parse(edit.keyPath.slice('hooks.state.'.length,-'.trusted_hash'.length));const hook=state.hooks.find(h=>h.key===key);if(hook.currentHash===edit.value&&!state.refuseTrust)hook.trustStatus='trusted';}result={status:'ok'};}
fs.writeFileSync(file,JSON.stringify(state));console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));});`);
  return { root, statePath, invoke: args => spawnSync(process.execPath, [script, '--project', root, ...args], { encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...process.env, PATH: [resolve(root, 'bin'), process.env.PATH].join(delimiter), TRUST_FIXTURE: statePath } }), state: () => JSON.parse(readFileSync(statePath)) };
}

test('listing returns actual hook metadata without approving anything', t => {
  const f = fixture(t); const r = f.invoke(['--plugin', 'geppetto@geppetto', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).hooks.length, 3);
  assert.deepEqual(f.state().edits, []);
});

test('scoped approval persists current hashes, preserves other settings and is idempotent', t => {
  const f = fixture(t); const args = ['--plugin', 'geppetto@geppetto', '--approve', '--json'];
  const r = f.invoke(args); assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).approved, 1);
  assert.deepEqual(f.state().edits, [{ keyPath: 'hooks.state."wanted".trusted_hash', value: 'sha256:wanted', mergeStrategy: 'upsert' }]);
  assert.equal(f.state().hooks[1].trustStatus, 'untrusted');
  assert.equal(f.state().hooks[2].enabled, false);
  assert.equal(f.state().hooks[3].trustStatus, 'managed');
  assert.equal(f.state().unrelated, 'preserved');
  const second = f.invoke(args); assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).approved, 0);
  assert.equal(f.state().edits.length, 1);
});

test('approval requires a named scope and never turns an empty match into success', t => {
  const f = fixture(t);
  for (const args of [['--approve'], ['--plugin', 'absent', '--approve']]) {
    const r = f.invoke(args); assert.notEqual(r.status, 0); assert.match(r.stderr, /scope|No hooks matched/); assert.deepEqual(f.state().edits, []);
  }
});

test('a definition changed after inventory is not approved', t => {
  const f = fixture(t, { changeOnRecheck: true });
  const r = f.invoke(['--key', 'wanted', '--approve']);
  assert.equal(r.status, 1); assert.match(r.stderr, /changed/i); assert.deepEqual(f.state().edits, []);
});

test('discovery errors and failed post-write verification cannot report success', t => {
  for (const changes of [{ discoveryError: true }, { refuseTrust: true }]) {
    const f = fixture(t, changes); const r = f.invoke(['--key', 'wanted', '--approve']);
    assert.equal(r.status, 1); assert.match(r.stderr, /could not read|verification failed/i);
    if (changes.discoveryError) assert.deepEqual(f.state().edits, []);
  }
});

test('protocol timeouts, malformed responses and early exit close the child', async () => {
  for (const [program, expected] of [
    ['process.stdin.resume()', /timed out/],
    ['console.log("not-json");process.stdin.resume()', /invalid JSON/],
    ['process.exit(3)', /exited/]
  ]) {
    const client = connectCodex({ command: { executable: process.execPath, prefix: ['-e', program, '--'] }, timeoutMs: 1000 });
    try { await assert.rejects(client.initialize(), expected); }
    finally { await client.close(); }
  }
});

test('source selection and explicit keys work for hooks sharing a source', t => {
  const f = fixture(t);
  const listed = f.invoke(['--source', resolve(f.root, 'hooks.json'), '--json']);
  assert.equal(listed.status, 0, listed.stderr); assert.equal(JSON.parse(listed.stdout).hooks.length, 4);
  const selected = f.invoke(['--key', 'other', '--approve', '--json']);
  assert.equal(selected.status, 0, selected.stderr); assert.equal(f.state().hooks[0].trustStatus, 'untrusted');
  assert.equal(f.state().hooks[1].trustStatus, 'trusted');
});
