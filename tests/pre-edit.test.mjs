import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixture, put, get, git, invoke, config } from './helpers.mjs';
import { handleEvent } from '../skills/geppetto-adopt/scripts/hook.mjs';
const decision = { requirements: { changes: false }, feedback: { applies: false }, frustration: { applies: false } };
function project(t, settings = {}) {
  const cwd = fixture(t);
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) git(cwd, args);
  put(cwd, 'README.md', '# Fixture'); put(cwd, '.geppetto/config.json', { ...config(), memory: { choice: 'none' }, hooks: { learnNudge: { enabled: false }, signalLearning: { enabled: false } }, ...settings });
  git(cwd, ['add', '.']); git(cwd, ['commit', '-qm', 'baseline']);
  const send = (kind, extra = {}) => handleEvent({ cwd, session_id: 'session', turn_id: 'turn', hook_event_name: kind, ...extra });
  const edit = (extra = {}) => send('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'README.md' }, ...extra });
  const record = (value, session = 'session', turn = 'turn') => invoke('hook.mjs', ['--record-turn', JSON.stringify(value), '--session', session, '--turn', turn], { cwd });
  const rows = () => get(cwd, '.geppetto/turns.jsonl').trim().split('\n').map(JSON.parse);
  return { cwd, send, edit, record, rows };
}
const denied = result => result.hookSpecificOutput?.permissionDecision === 'deny';
test('decision blocks once before first edit, persists measurement and never adds a Stop block', async t => {
  const { send, edit, record, rows } = project(t); await send('UserPromptSubmit');
  const blocked = await edit(); assert.ok(denied(blocked)); assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /--record-turn/);
  assert.equal(record(decision).status, 0); assert.deepEqual(await edit(), {});
  await Promise.all([send('Stop'), send('Stop')]); assert.equal(rows().length, 1); assert.equal(rows()[0].edited, true);
  assert.ok(Date.parse(rows()[0].requestedAt) < Date.parse(rows()[0].decidedAt)); assert.equal(rows()[0].addedSeconds, (Date.parse(rows()[0].decidedAt) - Date.parse(rows()[0].requestedAt)) / 1000);
});
test('bare Stop and edit-free turns never request or persist a decision', async t => {
  const { cwd, send } = project(t); assert.deepEqual(await send('Stop'), {}); await send('UserPromptSubmit');
  for (const [tool_name, tool_input] of [['Read', {}], ['Bash', { command: 'git diff --stat' }], ['exec_command', { cmd: 'Get-Content README.md' }]]) assert.deepEqual(await send('PreToolUse', { tool_name, tool_input }), {});
  assert.deepEqual(await send('Stop'), {}); assert.equal(existsSync(resolve(cwd, '.geppetto/turns.jsonl')), false);
});
test('write tools and supported shell writes gate, while quoted text and recording commands remain available', async t => {
  for (const [tool_name, tool_input] of [['Write', {}], ['MultiEdit', {}], ['functions.apply_patch', '*** Begin Patch'], ['Bash', { command: 'echo title > README.md' }], ['exec_command', { cmd: 'Set-Content README.md title' }], ['Bash', { command: 'sed -i s/a/b/ README.md' }], ['shell_command', { command: 'python -c "open(\'README.md\',\'w\').write(\'title\')"' }]]) {
    const { send } = project(t); assert.ok(denied(await send('PreToolUse', { tool_name, tool_input })), JSON.stringify(tool_input));
  }
  const { send } = project(t);
  for (const command of ['node hook.mjs --record-turn - --session session', 'echo "x > y"', 'rg "Set-Content" .', 'rg "writeFileSync" .']) assert.deepEqual(await send('PreToolUse', { tool_name: 'Bash', tool_input: { command } }), {});
});
test('configuration generates questions, validation and custom skill instructions; empty checks stay quiet', async t => {
  const { send, edit, record, rows } = project(t, { turnChecks: [{ id: 'privacy', question: 'Does this edit expose private material?', skill: 'privacy-review' }] });
  const text = (await send('SessionStart')).hookSpecificOutput.additionalContext;
  assert.match(text, /Does this edit expose private material\?/); assert.match(text, /\$privacy-review/); assert.match(text, /"privacy":\{"applies":false\}/); assert.doesNotMatch(text, /\$requirements-blast-radius/);
  await send('UserPromptSubmit'); assert.equal(record(decision).status, 2); assert.equal(record({ privacy: { applies: true, reason: 'none' } }).status, 2);
  assert.equal(record({ privacy: { applies: true, reason: 'The export includes account details.' } }).status, 0);
  assert.deepEqual(await edit(), {}); await send('Stop'); assert.equal(rows()[0].privacy.applies, true);
  const empty = project(t, { turnChecks: [] }); assert.deepEqual(await empty.send('SessionStart'), {}); assert.deepEqual(await empty.edit(), {}); assert.deepEqual(await empty.send('Stop'), {});
});
test('invalid and duplicate check definitions fail at the configuration boundary', async t => {
  for (const turnChecks of [[{ id: 'x', question: '', skill: 'test' }], [{ id: 'review', question: 'Question?', skill: 'test' }], [{ id: 'x', question: 'Question?', skill: 'test' }, { id: 'x', question: 'Question?', skill: 'test' }], { checks: [], rearmOn: [{ tool: '[' }] }]) {
    const { send } = project(t, { turnChecks }); await assert.rejects(send('SessionStart'), /turnChecks/);
  }
});
test('review reads rearm feedback alone, duplicate results and unrelated commands keep it valid', async t => {
  for (const [tool_name, command] of [['Bash', 'gh api repos/o/r/pulls/12/comments'], ['exec_command', 'gh api repos/o/r/pulls/12/reviews --paginate'], ['Bash', 'gh pr view 12 --comments'], ['Bash', 'python skills/code-review/scripts/run_review.py --base HEAD'], ['wait_agent', null], ['Bash', 'gh run view 12 --log-failed']]) {
    const { send, edit, record, rows } = project(t); await send('UserPromptSubmit'); assert.equal(record(decision).status, 0); await edit();
    const event = { tool_name, tool_input: command ? { command } : {}, tool_use_id: 'review-result' };
    await send('PostToolUse', event); assert.ok(denied(await edit()), command ?? tool_name); assert.equal(record(null).status, 2);
    assert.equal(record({ feedback: { applies: true, on: 'Incoming review.', action: 'Validated the finding at its owner.' } }).status, 0);
    await send('PostToolUse', event); assert.deepEqual(await edit(), {}); await send('Stop');
    assert.equal(rows()[0].requirements.changes, false); assert.equal(rows()[0].feedback.applies, true); assert.equal(rows()[0].decisions.length, 2);
  }
  const { send, edit, record } = project(t); await send('UserPromptSubmit'); record(decision);
  for (const command of ['gh api repos/o/r/issues/12/comments', 'gh pr view 12 --json body', 'echo "gh pr view --comments"', 'git diff', 'gh run view 12 --json conclusion']) await send('PostToolUse', { tool_name: 'Bash', tool_input: { command } });
  assert.deepEqual(await edit(), {});
});
test('custom rearm patterns replace defaults and continuation cannot bypass renewed feedback', async t => {
  const { send, edit, record } = project(t, { turnChecks: { rearmOn: [{ tool: '^Read$', command: '^review\\.json$' }] } });
  await send('UserPromptSubmit'); record({ continuation: true });
  await send('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'gh pr view --comments' } }); assert.deepEqual(await edit(), {});
  await send('PostToolUse', { tool_name: 'Read', tool_input: { command: 'review.json' } }); assert.ok(denied(await edit())); assert.equal(record({ continuation: true }).status, 2);
  assert.equal(record({ feedback: { applies: false } }).status, 0); assert.deepEqual(await edit(), {});
});
test('concurrent first edits deny once and the next turn is independently gated', async t => {
  const { send, edit } = project(t); await send('UserPromptSubmit'); assert.equal((await Promise.all([edit(), edit()])).filter(denied).length, 1);
  assert.deepEqual(await edit(), {}); assert.deepEqual(await send('Stop'), {});
  await send('UserPromptSubmit', { turn_id: 'two' }); assert.ok(denied(await edit({ turn_id: 'two' })));
});
test('a review result before any decision still requires all configured checks', async t => {
  const { send, edit, record } = project(t); await send('UserPromptSubmit');
  await send('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'gh pr view --comments' } });
  const block = await edit(); assert.ok(denied(block)); assert.match(block.hookSpecificOutput.permissionDecisionReason, /requirements.*feedback.*frustration/);
  assert.equal(record({ feedback: { applies: false } }).status, 2); assert.equal(record(decision).status, 0); assert.deepEqual(await edit(), {});
});
test('audit reports delay and classified corrections only for immediate next messages in the same session', t => {
  const { cwd } = project(t);
  put(cwd, '.geppetto/turns.jsonl', [{ sessionId: 's', turnId: 'a', edited: true, addedSeconds: 2 }, { sessionId: 's', turnId: 'b', previousTurnId: 'a', edited: true, addedSeconds: 6, userCorrection: true }, { sessionId: 's', turnId: 'd', previousTurnId: 'c', userCorrection: true }, { sessionId: 'other', turnId: 'x', previousTurnId: 'b', userCorrection: false }].map(JSON.stringify).join('\n') + '\n');
  const result = invoke('audit.mjs', ['--json'], { cwd }); assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout).turnChecks; assert.equal(report.medianAddedSeconds, 4); assert.equal(report.editedTurns, 2); assert.equal(report.correctedNextMessage, 1); assert.equal(report.classifiedNextMessages, 1); assert.equal(report.unclassifiedNextMessages, 1);
  assert.match(invoke('audit.mjs', [], { cwd }).stdout, /median.*4.*s.*1\/1/i);
});
