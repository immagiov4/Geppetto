import { projectDataPath } from '../skills/geppetto-adopt/scripts/project-records.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delimiter, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fixture, put, get, git } from './helpers.mjs';
import { runLearning, executeLearning } from '../skills/geppetto-adopt/scripts/learn-runner.mjs';

test('a successful CLI reporting an inaccessible owner leaves the signal pending and records the blocker', async t => {
  const root = fixture(t), home = fixture(t), old = { ...process.env };
  t.after(() => { process.env = old; });
  git(root, ['init', '-q']); git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  put(root, 'README.md', '# Current project\n'); git(root, ['add', '.']); git(root, ['commit', '-qm', 'baseline']);
  put(root, '.geppetto/config.json', { hooks: { signalLearning: { host: 'codex' } } });
  put(root, '.geppetto/signals.jsonl', '{"id":"unresolved","key":"unresolved","session":"fixture","source":"user","category":"workflow","status":"open","text":"Communication owner is outside the project"}\n');
  put(root, 'node_modules/@openai/codex/bin/codex.js', `
    const fs = require('node:fs');
    process.stdin.resume();
    process.stdin.on('end', () => {
      const args = process.argv.slice(2), path = args[args.indexOf('--output-last-message') + 1];
      if (args.includes('--output-last-message')) fs.writeFileSync(path, JSON.stringify({decision:'blocked',reason:'The communication owner is outside the permitted scope.',owner:'writing-for-humans'}));
    });
  `);
  process.env.PATH = `${root}${delimiter}${old.PATH}`;
  const context = { session_id: 'origin-session', turn_id: 'origin-turn' };
  const result = await runLearning(root, { home, context });
  assert.equal(result.status, 'blocked');
  const state = JSON.parse(get(root, projectDataPath(root, 'learning.json')));
  assert.notEqual(state.lastId, 'unresolved');
  assert.equal(state.assessment.owner, 'writing-for-humans');
  assert.match(state.assessment.reason, /outside the permitted scope/);
  const blockedEvent = JSON.parse(get(root, projectDataPath(root, 'hook-events.jsonl')).trim());
  assert.equal(blockedEvent.sessionId, context.session_id); assert.equal(blockedEvent.turnId, context.turn_id);
  let prompt;
  const retry = await runLearning(root, { home, context: { ...context, turn_id: 'retry-turn' }, execute: async request => {
    prompt = request.prompt;
    return { decision: 'no_change', reason: 'The existing communication procedure already covers this correction.', owner: 'writing-for-humans' };
  } });
  assert.match(prompt, /unresolved/); assert.equal(retry.status, 'unchanged');
  assert.equal(JSON.parse(get(root, projectDataPath(root, 'learning.json'))).lastId, 'unresolved');
  const retryEvent = JSON.parse(get(root, projectDataPath(root, 'hook-events.jsonl')).trim().split('\n').at(-1));
  assert.equal(retryEvent.sessionId, context.session_id); assert.equal(retryEvent.turnId, 'retry-turn');
});

test('missing, malformed and contradictory assessments never consume pending evidence', async t => {
  const root = fixture(t), home = fixture(t);
  git(root, ['init', '-q']); git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  put(root, 'README.md', '# Project\n'); git(root, ['add', '.']); git(root, ['commit', '-qm', 'baseline']);
  put(root, '.geppetto/signals.jsonl', '{"id":"pending","key":"pending","session":"fixture","source":"user","category":"workflow","status":"open","text":"Assess this correction"}\n');
  for (const assessment of [undefined, 0, { decision: 'no_change', reason: '', owner: 'README.md' },
    { decision: 'unknown', reason: 'Unknown.', owner: 'README.md' },
    { decision: 'applied', reason: 'Claims an edit that does not exist.', owner: 'README.md' }]) {
    await assert.rejects(runLearning(root, { home, execute: async () => assessment }), /valid decision|contradicts/);
    assert.equal(existsSync(projectDataPath(root, 'learning.json')), false);
  }
  await assert.rejects(runLearning(root, { home, execute: async ({ cwd }) => {
    put(cwd, 'lesson.md', 'Unacknowledged output\n');
    return { decision: 'no_change', reason: 'Claims no changes despite writing a file.', owner: 'lesson.md' };
  } }), /contradicts/);
  const blocked = await runLearning(root, { home, execute: async ({ cwd }) => {
    put(cwd, 'lesson.md', 'Partial work\n');
    return { decision: 'blocked', reason: 'A second owner remains inaccessible.', owner: 'external owner' };
  } });
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.lastId, null);
  assert.equal(git(blocked.path, ['rev-parse', 'HEAD']).stdout.trim(), blocked.baseline);
  assert.equal(get(blocked.path, 'lesson.md'), 'Partial work\n');
});

test('Claude structured output is required and a host-reported failure cannot masquerade as completion', async t => {
  const root = fixture(t), old = { ...process.env };
  t.after(() => { process.env = old; });
  put(root, 'node_modules/@anthropic-ai/claude-code/cli.js', `
    const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{
      const args=process.argv.slice(2);fs.writeFileSync('claude-args.json',JSON.stringify(args));
      console.log(JSON.stringify(process.env.FIXTURE_RESULT==='error'
        ? {is_error:true,structured_output:{decision:'no_change',reason:'Not reliable.',owner:'README.md'}}
        : process.env.FIXTURE_RESULT==='missing' ? {result:'No structured answer'}
        : {is_error:false,structured_output:{decision:'no_change',reason:'Already covered.',owner:'README.md'}}));
    });
  `);
  process.env.PATH = root;
  const request = { cwd: root, host: 'claude', prompt: 'Assess the existing owner.', resultPath: resolve(root, 'report.json') };
  assert.equal((await executeLearning(request)).decision, 'no_change');
  const args = JSON.parse(get(root, 'claude-args.json'));
  assert.equal(args[args.indexOf('--output-format') + 1], 'json');
  assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema') + 1]).properties.decision.enum, ['applied', 'no_change', 'blocked']);
  process.env.FIXTURE_RESULT = 'error'; await assert.rejects(executeLearning(request), /reported failure/);
  process.env.FIXTURE_RESULT = 'missing'; await assert.rejects(executeLearning(request), /valid decision/);
});
