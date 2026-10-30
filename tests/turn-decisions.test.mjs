import { projectDataPath } from '../skills/geppetto-adopt/scripts/project-records.mjs';
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
  assert.equal(JSON.parse(get(cwd, projectDataPath(cwd, 'turns.jsonl'))).continuation, true);
});
test('Stop without prior events stays silent and initializes recording and the command accepts JSON stdin', async t => {
  const { cwd, send } = project(t);
  assert.deepEqual(await send('Stop'), {});
  const result = invoke('hook.mjs', ['--record-turn', '-', '--session', 'session', '--turn', 'turn'], { cwd, input: JSON.stringify(decision) });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(await send('Stop'), {});
});
