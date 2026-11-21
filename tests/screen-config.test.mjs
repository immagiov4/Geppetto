import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { appendRecord } from '../skills/geppetto-adopt/scripts/common.mjs';
import { handleEvent, recordTurn } from '../skills/geppetto-adopt/scripts/hook.mjs';
import { screenSourceStatus } from '../skills/geppetto-adopt/scripts/screen-config.mjs';
import { config, fixture, get, git, put, repo, restoreEnv } from './helpers.mjs';

test('the project override wins and an unconfigured public origin is checked anonymously', async t => {
  const root = fixture(t), home = fixture(t);
  git(root, ['init', '-q']);
  git(root, ['remote', 'add', 'origin', 'ssh://git@github.com/example/public-project.git']);
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/example/public-project');
    assert.equal(options.headers.authorization, undefined);
    return Response.json({ private: false, full_name: 'example/public-project' });
  });
  assert.equal((await screenSourceStatus(root, { home })).scope, 'public');
  put(home, '.geppetto/config.json', { screen: { shareSource: true } });
  assert.equal((await screenSourceStatus(root, { home })).scope, 'user');
  put(root, '.geppetto/config.json', { screen: { shareSource: false } });
  assert.equal((await screenSourceStatus(root, { home })).shareSource, false);
  assert.equal(fetch.mock.callCount(), 1);
});

test('an eligible substantial turn requires a provider screen event for the current turn', async t => {
  const root = fixture(t), saved = { ...process.env };
  t.after(() => restoreEnv(saved));
  process.env.OPENROUTER_API_KEY = 'fixture';
  for (const args of [['init','-q'], ['config','user.name','Fixture'], ['config','user.email','fixture@example.invalid']]) git(root, args);
  put(root, '.geppetto/config.json', { ...config(), screen: { shareSource: true } });
  put(root, 'source.mjs', 'export const data = true;');
  git(root, ['add','.']); git(root, ['commit','-qm','fixture']);
  const ctx = { cwd: root, session_id: 'screen', turn_id: 'active', hook_event_name: 'UserPromptSubmit' };
  await handleEvent(ctx);
  const decision = { requirements: { changes: true, what: 'Update application reports.', foundation: false },
    feedback: { applies: false }, frustration: { applies: false } };
  await assert.rejects(recordTurn(root, ctx.session_id, ctx.turn_id, decision), /requirements\.screenRun/);
  decision.requirements.screenRun = 'a'.repeat(32);
  const entry = { hook: 'requirementsScreen', runId: decision.requirements.screenRun, sessionId: ctx.session_id,
    turnId: ctx.turn_id, status: 'skipped', ts: new Date().toISOString(), mode: 'decisions', worktree: root,
    revision: git(root, ['rev-parse', 'HEAD']).stdout.trim() };
  await appendRecord(root, 'hook-events', entry);
  await assert.rejects(recordTurn(root, ctx.session_id, ctx.turn_id, decision), /requirements\.screenRun/);
  await appendRecord(root, 'hook-events', { ...entry, status: 'completed', mode: 'chat' });
  await assert.rejects(recordTurn(root, ctx.session_id, ctx.turn_id, decision), /requirements\.screenRun/);
  const responseFile = resolve(root, 'result.json');
  put(root, 'request.txt', 'Update application reports.');
  const command = [
    'import importlib.util, sys',
    'spec = importlib.util.spec_from_file_location("screen", sys.argv.pop(1))',
    'screen = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(screen)',
    'screen.decisions_catalog = lambda: [{"id":"perplexity/pplx-decider-v1.3:free","created":1}]',
    'screen.api = lambda *args, **kwargs: {"model":"perplexity/pplx-decider-v1.3:free","answers":{"relevant":{"type":"noul","noul":0.8},"reason":{"type":"choice","choice":"capability"}}}',
    'raise SystemExit(screen.main())',
  ].join('\n');
  const screen = spawnSync('python', ['-B', '-c', command,
    resolve(repo, 'skills/requirements-blast-radius/scripts/screen.py'),
    '--repo', root, '--request-file', resolve(root, 'request.txt'), '--cache', resolve(root, 'cache'),
    '--session', ctx.session_id, '--model', 'perplexity/pplx-decider-v1.3:free', '--output', responseFile],
  { cwd: root, windowsHide: true, encoding: 'utf8' });
  assert.equal(screen.status, 0, screen.stdout + screen.stderr);
  const response = JSON.parse(get(root, responseFile));
  decision.requirements.screenRun = response.screenRun;
  assert.equal(response.served_models[0], 'perplexity/pplx-decider-v1.3:free');
  assert.deepEqual(await recordTurn(root, ctx.session_id, ctx.turn_id, decision), decision);
});
