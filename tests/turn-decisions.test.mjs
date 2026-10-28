import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, put, get, git, invoke, config } from './helpers.mjs';
import { handleEvent } from '../skills/geppetto-adopt/scripts/hook.mjs';

const decision = { requirements: { changes: false }, feedback: { applies: false }, frustration: { applies: false } };
function project(t) {
  const cwd = fixture(t);
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) git(cwd, args);
  put(cwd, 'README.md', '# Fixture'); put(cwd, '.geppetto/config.json', { ...config(), hooks: { signalLearning: { enabled: false } } });
  git(cwd, ['add', '.']); git(cwd, ['commit', '-qm', 'baseline']);
  const send = (kind, extra = {}) => handleEvent({ cwd, session_id: 'session', turn_id: 'turn', hook_event_name: kind, ...extra });
  const record = (value, session = 'session', turn = 'turn') => invoke('hook.mjs', ['--record-turn', JSON.stringify(value), '--session', session, '--turn', turn], { cwd });
  return { cwd, send, record };
}
test('missing decision blocks once with the record command; a valid decision closes and persists gate review', async t => {
  const { cwd, send, record } = project(t);
  assert.deepEqual(await send('UserPromptSubmit', { prompt: 'Read the project.' }), {});
  const blocked = await send('Stop'); assert.equal(blocked.decision, 'block'); assert.match(blocked.reason, /hook\.mjs.*--record-turn/);
  assert.match(blocked.reason, /requirements.*feedback.*frustration/);
  const written = record(decision); assert.equal(written.status, 0, written.stderr);
  assert.deepEqual(await send('Stop', { stop_hook_active: true }), {});
  const rows = get(cwd, '.geppetto/turns.jsonl').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1); assert.equal(rows[0].requirements.changes, false); assert.equal(rows[0].review.status, 'below-threshold');
  assert.equal(rows[0].sessionId, 'session'); assert.equal(rows[0].turnId, 'turn');
  assert.equal(git(cwd, ['check-ignore', '.geppetto/turns.jsonl']).status, 0);
  assert.deepEqual(await send('Stop'), {}); assert.equal(get(cwd, '.geppetto/turns.jsonl').trim().split('\n').length, 1);
});
test('a repeated missing decision closes, and the next turn blocks independently', async t => {
  const { send } = project(t); await send('UserPromptSubmit');
  assert.equal((await send('Stop')).decision, 'block'); assert.deepEqual(await send('Stop'), {});
  await send('UserPromptSubmit', { turn_id: 'two' }); assert.equal((await send('Stop', { turn_id: 'two' })).decision, 'block');
});
test('positive decisions require meaningful reasons, and continuation is accepted', async t => {
  const { cwd, send, record } = project(t); await send('UserPromptSubmit');
  for (const placeholder of ['n/a', 'none', '-', 'ok', 'no', 'TBD', '**none**', ' ']) {
    for (const value of [
      { ...decision, requirements: { changes: true, what: placeholder } },
      { ...decision, feedback: { applies: true, on: placeholder, action: 'Checked the requested correction.' } },
      { ...decision, frustration: { applies: true, cause: 'Repeated scope mistake.', prevention: placeholder } },
    ]) assert.equal(record(value).status, 2, JSON.stringify(value));
  }
  for (const value of [{}, { requirements: { changes: 'false' } }, { continuation: true, feedback: {} }, { ...decision, review: { status: 'reviewed' } }, { ...decision, requirements: { changes: true, what: 'A\nB' } }]) assert.equal(record(value).status, 2);
  assert.equal(record({ continuation: true }).status, 0); assert.deepEqual(await send('Stop'), {});
  assert.equal(JSON.parse(get(cwd, '.geppetto/turns.jsonl')).continuation, true);
});
test('positive reasons persist, records stay bound to the current session/turn, and review shares one block', async t => {
  const { cwd, send, record } = project(t); await send('UserPromptSubmit');
  assert.equal(record(decision, 'foreign').status, 2); assert.equal(record(decision, 'session', 'old').status, 2);
  put(cwd, 'app.mjs', Array.from({ length: 40 }, (_, i) => `export const x${i} = ${i};\n`).join(''));
  const block = await send('Stop'); assert.match(block.reason, /--record-turn/); assert.match(block.reason, /independent review/);
  const positive = { requirements: { changes: true, what: 'The requested output includes cancellation.' }, feedback: { applies: true, on: 'The cancellation flow.', action: 'Verified the request and corrected its owner.' }, frustration: { applies: true, cause: 'Repeatedly missing cancellation.', prevention: 'Added a regression at the existing owner.' } };
  assert.equal(record(positive).status, 0); assert.deepEqual(await send('Stop'), {});
  assert.equal(JSON.parse(get(cwd, '.geppetto/turns.jsonl')).review.status, 'second-stop');
  await send('UserPromptSubmit', { turn_id: 'two' }); assert.equal((await send('Stop', { turn_id: 'two' })).decision, 'block');
});
test('parallel Stop deliveries emit one combined block and one final record', async t => {
  const { cwd, send, record } = project(t); await send('UserPromptSubmit');
  const results = await Promise.all([send('Stop'), send('Stop')]); assert.equal(results.filter(r => r.decision === 'block').length, 1);
  assert.equal(record(decision).status, 0); await Promise.all([send('Stop'), send('Stop')]);
  assert.equal(get(cwd, '.geppetto/turns.jsonl').trim().split('\n').length, 1);
});
test('Stop without prior events still asks for a record and the command accepts JSON stdin', async t => {
  const { cwd, send } = project(t);
  assert.equal((await send('Stop')).decision, 'block');
  const result = invoke('hook.mjs', ['--record-turn', '-', '--session', 'session', '--turn', 'turn'], { cwd, input: JSON.stringify(decision) });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(await send('Stop'), {});
});
