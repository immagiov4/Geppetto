import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { open, mkdir, rmdir, readFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, put } from './helpers.mjs';
import { atomicJson, jsonFile } from '../skills/geppetto-adopt/scripts/common.mjs';
import { learningEvent } from '../skills/geppetto-adopt/scripts/learn-nudge.mjs';
import { turnStatePath, withTurnLock } from '../skills/geppetto-adopt/scripts/turn-messages.mjs';

test('learning activity releases its real state reader before a session writer replaces the snapshot', { timeout: 15000 }, async t => {
  const root = fixture(t), session = 'shared-state', path = turnStatePath(root, session), lock = `${path}.lock`;
  const state = { turn: 'parent', userEpoch: 'message', epoch: 'initial' };
  put(root, '.geppetto/config.json', { hooks: { learnNudge: { enabled: true } } });
  await atomicJson(path, state);
  let entered, release, contended;
  const opened = new Promise(done => { entered = done; }), held = new Promise(done => { release = done; }), waiting = new Promise(done => { contended = done; });
  const original = fs.promises.readFile; let first = true, reader, writer;
  fs.promises.readFile = async (file, ...args) => {
    if (String(file) === path && first) {
      first = false; const handle = await open(file, 'r'); entered();
      try { await held; return await handle.readFile(...args); } finally { await handle.close(); }
    }
    const value = await original(file, ...args);
    if (String(file) === lock) contended();
    return value;
  };
  syncBuiltinESMExports();
  try {
    reader = learningEvent({ cwd: root, session_id: session, turn_id: 'parent', hook_event_name: 'PreToolUse', tool_use_id: 'held-reader' }, () => 1);
    await opened;
    writer = withTurnLock(lock, () => atomicJson(path, { ...state, marker: 'written' }));
    const order = await Promise.race([writer.then(() => 'completed-before-reader', () => 'failed-before-reader'), waiting.then(() => 'waited-for-reader')]);
    release(); await reader; await writer;
    assert.equal(order, 'waited-for-reader');
    assert.equal((await jsonFile(path)).marker, 'written');
    const activity = resolve(root, '.geppetto/hook-state', createHash('sha256').update(session).digest('hex'), 'activity.jsonl');
    assert.equal(JSON.parse((await readFile(activity, 'utf8')).trim()).turn, 'parent:message');
  } finally {
    release(); await Promise.allSettled([reader, writer].filter(Boolean));
    fs.promises.readFile = original; syncBuiltinESMExports();
  }
});

test('a failed atomic replacement leaves the original destination and permits recovery in the same process', async t => {
  const root = fixture(t), path = resolve(root, 'state.json');
  await mkdir(path); put(root, 'state.json/owner', 'original');
  await assert.rejects(atomicJson(path, { value: 'new' }));
  assert.equal(await readFile(resolve(path, 'owner'), 'utf8'), 'original');
  await fs.promises.unlink(resolve(path, 'owner')); await rmdir(path);
  await atomicJson(path, { value: 'recovered' }, { mode: 0o600 });
  assert.deepEqual(await jsonFile(path), { value: 'recovered' });
});

test('an existing atomic temporary is preserved when exclusive creation fails', async t => {
  const root = fixture(t), path = resolve(root, 'state.json'), temp = `${path}.${process.pid}.tmp`;
  put(root, 'state.json', { value: 'original' }); put(root, `state.json.${process.pid}.tmp`, 'pre-existing owner');
  await assert.rejects(atomicJson(path, { value: 'new' }), { code: 'EEXIST' });
  assert.deepEqual(await jsonFile(path), { value: 'original' });
  assert.equal(await readFile(temp, 'utf8'), 'pre-existing owner');
});


test('atomic write diagnostics retain both write and close failures', async t => {
  const root = fixture(t), path = resolve(root, 'state.json'), original = fs.promises.open;
  put(root, 'state.json', { value: 'original' });
  fs.promises.open = async (...args) => {
    const handle = await original(...args), close = handle.close.bind(handle);
    handle.writeFile = async () => { throw new Error('write failed'); };
    handle.close = async () => { await close(); throw new Error('close failed'); };
    return handle;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(atomicJson(path, { value: 'new' }), error => {
      assert.match(error.message, /write failed; close failed: close failed/);
      assert.equal(error.cause.message, 'write failed');
      assert.deepEqual(error.errors.map(cause => cause.message), ['write failed', 'close failed']);
      return true;
    });
    assert.deepEqual(await jsonFile(path), { value: 'original' });
    assert.equal(fs.existsSync(`${path}.${process.pid}.tmp`), false);
  } finally { fs.promises.open = original; syncBuiltinESMExports(); }
});

test('cleanup diagnostics retain the publication and cleanup reasons', async t => {
  const root = fixture(t), path = resolve(root, 'state.json'), original = fs.promises.unlink;
  await mkdir(path); put(root, 'state.json/owner', 'original');
  fs.promises.unlink = async () => { throw new Error('cleanup denied'); };
  syncBuiltinESMExports();
  try {
    await assert.rejects(atomicJson(path, { value: 'new' }), error => {
      assert.match(error.message, /temporary cleanup failed: cleanup denied/);
      assert.ok(error.message.includes(error.cause.message));
      assert.equal(error.errors[1].message, 'cleanup denied');
      return true;
    });
    assert.equal(await readFile(resolve(path, 'owner'), 'utf8'), 'original');
  } finally { fs.promises.unlink = original; syncBuiltinESMExports(); }
});
