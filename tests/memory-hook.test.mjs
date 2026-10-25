import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { symlinkSync, existsSync } from 'node:fs';
import { fixture, put, get, invoke, git, config } from './helpers.mjs';

const rootIndex = '# Buckets\n\n| Bucket | Scope | Holds |\n|---|---|---|\n| [private](buckets/private/index.md) | global | Personal facts. |\n| [preferences](buckets/preferences/index.md) | global | Working preferences. |\n| [my-app](buckets/my-app/index.md) | project | My app facts. |\n| [geppetto](buckets/geppetto/index.md) | project | Geppetto facts. |\n';
function setup(t) {
  const cwd = fixture(t); const home = fixture(t); const memory = fixture(t); git(memory, ['init', '-q']);
  put(memory, 'index.md', rootIndex); put(memory, 'buckets/my-app/index.md', '# My app\n\n[Playback](playback.md) — Timing facts.\n');
  put(memory, 'buckets/geppetto/index.md', '# Geppetto\n\n[Hooks](hooks.md) — Hook facts.\n');
  put(memory, 'buckets/private/index.md', 'PRIVATE INDEX MUST STAY OUT'); put(memory, 'buckets/my-app/playback.md', 'PAGE MUST STAY OUT');
  put(home, '.geppetto/config.json', { memory: { repo: 'https://example.invalid/memory', localPath: memory, buckets: ['geppetto'] } });
  return { cwd, home, memory };
}
const session = (cwd, home) => invoke('memory-hook.mjs', [], { cwd, home, input: JSON.stringify({ hook_event_name: 'SessionStart', cwd }) });

test('session memory context lists every bucket and injects only linked nonprivate indexes, with exact byte accounting', t => {
  const { cwd, home, memory } = setup(t);
  put(cwd, '.geppetto/config.json', { ...config(), memory: { buckets: ['my-app', 'geppetto', 'private'] } });
  const r = session(cwd, home); assert.equal(r.status, 0, r.stderr); const output = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, 'SessionStart');
  assert.equal(output.additionalContext, `Memories live here: ${memory} (https://example.invalid/memory). Read and update them through $geppetto-memory.\nGlobal buckets:\nprivate — Personal facts.\npreferences — Working preferences.\nProject buckets:\nmy-app — My app facts.\ngeppetto — Geppetto facts.\nPROJECT bucket index (my-app):\n# My app\n\n[Playback](playback.md) — Timing facts.\n\nPROJECT bucket index (geppetto):\n# Geppetto\n\n[Hooks](hooks.md) — Hook facts.\n`);
  assert.doesNotMatch(output.additionalContext, /PRIVATE INDEX|PAGE MUST/);
  const log = JSON.parse(get(cwd, '.geppetto/hook-events.jsonl')); assert.equal(log.injectedBytes, Buffer.byteLength(output.additionalContext)); assert.equal(log.modelCalls, 0); assert.equal(log.event, 'SessionStart');
});

test('legacy projectBucket overrides user buckets and the array form takes precedence over the old key', t => {
  const { cwd, home } = setup(t); put(cwd, '.geppetto/config.json', { memory: { projectBucket: 'my-app' } });
  let r = session(cwd, home); assert.equal(r.status, 0, r.stderr); let text = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(text, /PROJECT bucket index \(my-app\)/); assert.doesNotMatch(text, /PROJECT bucket index \(geppetto\)/);
  put(cwd, '.geppetto/config.json', { memory: { buckets: [], projectBucket: 'my-app' } }); r = session(cwd, home); text = JSON.parse(r.stdout).hookSpecificOutput.additionalContext; assert.doesNotMatch(text, /PROJECT bucket index/);
  put(cwd, '.geppetto/config.json', { memory: { buckets: ['PRIVATE'] } }); r = session(cwd, home); text = JSON.parse(r.stdout).hookSpecificOutput.additionalContext; assert.doesNotMatch(text, /PRIVATE INDEX|PROJECT bucket index/);
});

test('configured unavailable memory emits one reasoned line; absent configuration emits no context', t => {
  const { cwd, home } = setup(t); put(cwd, '.geppetto/config.json', { memory: { localPath: 'missing', buckets: [] } });
  let r = session(cwd, home); assert.equal(r.status, 0, r.stderr); const text = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(text, /^Memory is configured but unavailable: .*clone.*$/); assert.equal(text.split('\n').length, 1);
  assert.equal(JSON.parse(get(cwd, '.geppetto/hook-events.jsonl')).status, 'unavailable');
  const empty = fixture(t); r = session(empty, empty); assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), {});
});

test('memory bucket names cannot escape their root and missing configured indexes are named', t => {
  const { cwd, home } = setup(t); put(cwd, '.geppetto/config.json', { memory: { buckets: ['../escape'] } });
  let r = session(cwd, home); assert.equal(r.status, 0, r.stderr); assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /unavailable.*buckets/);
  put(cwd, '.geppetto/config.json', { memory: { buckets: ['absent'] } }); r = session(cwd, home); assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /PROJECT bucket index \(absent\):\nUnavailable/);
});

test('a linked alias cannot inject a private bucket index through a directory junction', t => {
  const { cwd, home, memory } = setup(t);
  symlinkSync(resolve(memory, 'buckets/private'), resolve(memory, 'buckets/alias'), process.platform === 'win32' ? 'junction' : 'dir');
  put(cwd, '.geppetto/config.json', { memory: { buckets: ['alias'] } });
  const r = session(cwd, home); assert.equal(r.status, 0, r.stderr); const text = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(text, /unavailable.*outside its configured owner/); assert.doesNotMatch(text, /PRIVATE INDEX/);
});

test('the user-level ~/.geppetto config never makes the home directory a project', t => {
  const home = fixture(t); const cwd = resolve(home, 'work', 'scratch'); put(cwd, 'note.txt', 'x');
  put(home, '.geppetto/config.json', { memory: { localPath: 'missing-memory' } });
  const r = session(cwd, home); assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(resolve(home, '.geppetto/hook-events.jsonl')), 'home must not receive project hook events');
});


test('project discovery stops at the user home before reading ancestor configuration', t => {
  const ancestor = fixture(t); const home = resolve(ancestor, 'home'); const cwd = resolve(home, 'work');
  put(cwd, 'note.txt', 'x');
  put(ancestor, '.geppetto/config.json', { memory: { localPath: 'unrelated-memory' } });
  const r = session(cwd, home); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {});
  assert.ok(!existsSync(resolve(ancestor, '.geppetto/hook-events.jsonl')));
});
