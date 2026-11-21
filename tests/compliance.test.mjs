import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config, fixture, get, git, put } from './helpers.mjs';
import { handleEvent, recordTurn } from '../skills/geppetto-adopt/scripts/hook.mjs';
import { metricsAudit } from '../skills/geppetto-adopt/scripts/metrics-audit.mjs';
import { projectDataPath } from '../skills/geppetto-adopt/scripts/project-records.mjs';

const plain = { requirements: { changes: false }, feedback: { applies: false }, frustration: { applies: false } };

function project(t, codex = true) {
  const cwd = fixture(t);
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.name', 'Fixture']);
  git(cwd, ['config', 'user.email', 'fixture@example.invalid']);
  put(cwd, 'AGENTS.md', '# Rules\n');
  put(cwd, '.geppetto/config.json', config());
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-qm', 'baseline']);
  const session = 'gate-session', turn = codex ? 'native-turn' : undefined;
  const send = (hook_event_name, extra) => handleEvent({ cwd, session_id: session, turn_id: turn, hook_event_name, ...extra });
  return {
    cwd, send, record: value => recordTurn(cwd, session, turn, value),
    edit: () => send('PreToolUse', { tool_name: 'apply_patch', tool_input: {} }),
    events: () => get(cwd, projectDataPath(cwd, 'hook-events.jsonl')).trim().split('\n').map(JSON.parse),
  };
}

test('Codex requires a recorded decision before retrying a denied edit', async t => {
  const { cwd, send, edit, record, events } = project(t);
  assert.equal((await edit()).hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal((await edit()).hookSpecificOutput?.permissionDecision, 'deny');
  await record(plain);
  assert.equal((await edit()).hookSpecificOutput?.permissionDecision, undefined);
  await send('Stop');
  const editEvents = events().filter(event => event.hook === 'turnGate' && event.disposition);
  assert.deepEqual(editEvents.map(row => row.disposition), ['denied', 'denied', 'decision']);
  assert.ok(editEvents.every(row => row.harness === 'codex' && row.turnId === 'native-turn' && row.epoch === 'initial'));
  const audit = await metricsAudit(cwd, { key: 'fixture', execute: () => ({ status: 1 }) });
  const codex = audit.compliance.find(row => row.harness === 'codex');
  assert.equal(codex.editEpochs, 1);
  assert.equal(codex.checkedEdits, 1);
  assert.equal(codex.uncheckedEdits, 0);
  assert.ok(codex.joined >= 4);
});

test('Codex retries Stop only after a learning outcome or recorded override', async t => {
  const { send, record } = project(t);
  await send('UserPromptSubmit');
  await record({ ...plain, frustration: { applies: true, cause: 'Repeated failure.', prevention: 'Correct the documented workflow.' } });
  assert.equal((await send('Stop')).decision, 'block');
  const retry = await send('Stop', { stop_hook_active: true });
  assert.equal(retry.decision, 'block');
  assert.match(retry.reason, /--record-turn/);
  await record({ override: { gate: 'stop', reason: 'The external owner is unavailable in this session.' } });
  assert.equal((await send('Stop', { stop_hook_active: true })).decision, undefined);
});

test('Claude retains its first-edit retry behaviour', async t => {
  const { edit } = project(t, false);
  assert.equal((await edit()).hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal((await edit()).hookSpecificOutput?.permissionDecision, undefined);
});

test('Codex edit overrides expire with the active decision epoch', async t => {
  const { edit, record, send, events } = project(t);
  assert.equal((await edit()).hookSpecificOutput?.permissionDecision, 'deny');
  await record({ override: { gate: 'edit', reason: 'The maintainer approved the stated fixture setup.' } });
  assert.equal((await edit()).hookSpecificOutput?.permissionDecision, undefined);
  assert.ok(events().some(row => row.hook === 'turnGate' && row.disposition === 'override'));
  const next = await send('PreToolUse', { turn_id: 'next', tool_name: 'apply_patch', tool_input: {} });
  assert.equal(next.hookSpecificOutput?.permissionDecision, 'deny');
});
