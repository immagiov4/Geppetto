import { projectDataPath } from '../skills/geppetto-adopt/scripts/project-records.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixture, put, get, git, invoke, config } from './helpers.mjs';
import { spawnSync } from 'node:child_process';
import { handleEvent } from '../skills/geppetto-adopt/scripts/hook.mjs';
const decision = { requirements: { changes: false }, feedback: { applies: false }, frustration: { applies: false } };
function project(t, settings = {}, nested = false) {
  const root = fixture(t), cwd = nested ? resolve(root, 'app') : root;
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) git(root, args);
  put(cwd, 'README.md', '# Fixture'); put(cwd, '.geppetto/config.json', { ...config(), memory: { choice: 'none' }, hooks: { learnNudge: { enabled: false }, signalLearning: { enabled: false } }, ...settings });
  git(cwd, ['add', '.']); git(cwd, ['commit', '-qm', 'baseline']);
  const send = (kind, extra = {}) => handleEvent({ cwd, session_id: 'session', turn_id: 'turn', hook_event_name: kind, ...extra });
  const edit = (extra = {}) => send('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'README.md' }, ...extra });
  const record = (value, session = 'session', turn = 'turn') => invoke('hook.mjs', ['--record-turn', JSON.stringify(value), '--session', session, '--turn', turn], { cwd });
  const rows = () => get(cwd, projectDataPath(cwd, 'turns.jsonl')).trim().split('\n').map(JSON.parse);
  return { root, cwd, send, edit, record, rows };
}
const denied = result => result.hookSpecificOutput?.permissionDecision === 'deny';
test('F1: PreToolUse and PostToolUse errors fail open with one diagnostic; audit/install validate config', async t => {
  for (const broken of ['config', 'state']) {
    const { cwd, send } = project(t); await send('UserPromptSubmit');
    const state = readdirSync(resolve(cwd, '.geppetto/hook-state')).find(name => /^review-turn-.*\.json$/.test(name));
    put(cwd, broken === 'config' ? '.geppetto/config.json' : `.geppetto/hook-state/${state}`, '{');
    for (const hook_event_name of ['PreToolUse', 'PostToolUse']) for (const tool_name of ['Read', 'Edit', 'exec_command']) {
      const result = invoke('hook.mjs', [], { cwd, input: JSON.stringify({ cwd, session_id: 'session', turn_id: 'turn', hook_event_name, tool_name, tool_input: { cmd: 'Get-Content README.md' } }) });
      assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), {});
      assert.equal(result.stderr.trim().split(/\r?\n/).length, 1); assert.match(result.stderr, /Geppetto.*diagnostic/);
    }
  }
  const { cwd, send } = project(t, { turnChecks: { rearmOn: [{ tool: '[' }] } });
  for (const kind of ['PreToolUse', 'PostToolUse']) assert.deepEqual(await send(kind, { tool_name: 'Read', tool_input: {} }), {});
  const audit = invoke('audit.mjs', ['--verify', '--json'], { cwd }); assert.notEqual(audit.status, 0); assert.match(audit.stdout + audit.stderr, /turnChecks/);
  const install = invoke('install.mjs', ['--target', 'claude', '--project', cwd, '--dry-run'], { cwd }); assert.notEqual(install.status, 0); assert.match(install.stderr, /turnChecks/);
  const malformed = invoke('hook.mjs', [], { cwd, input: '{' }); assert.equal(malformed.status, 0); assert.deepEqual(JSON.parse(malformed.stdout), {}); assert.equal(malformed.stderr.trim().split(/\r?\n/).length, 1);
});
test('F2: read-only shell reproductions run without a decision request', async t => {
  const { cwd, send } = project(t); put(cwd, 'README.md', 'sed\n'); await send('UserPromptSubmit');
  for (const [executable, args, command] of [
    ['node', ['-e', "console.log('write(')"], 'node -e "console.log(\'write(\')"'],
    ['python', ['-c', "print('write(')"], 'python -c "print(\'write(\')"'],
    ['rg', ['sed', '-i', 'README.md'], 'rg sed -i README.md'],
  ]) {
    const event = { tool_name: 'Bash', tool_input: { command } };
    assert.deepEqual(await send('PreToolUse', event), {});
    const result = spawnSync(executable, args, { cwd, encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await send('PostToolUse', event), {});
  }
  assert.equal(get(cwd, 'README.md'), 'sed\n'); assert.deepEqual(await send('Stop'), {});
  assert.equal(existsSync(projectDataPath(cwd, 'turns.jsonl')), false);
});
test('F2: shell effects on clean, dirty, untracked and staged paths ask once at the next tool boundary', async t => {
  for (const mode of ['clean', 'dirty', 'untracked', 'staged']) {
    const { cwd, send, record, rows } = project(t);
    const path = mode === 'untracked' ? 'new.txt' : 'README.md';
    if (['dirty', 'untracked'].includes(mode)) put(cwd, path, 'before\n');
    await send('UserPromptSubmit');
    const event = { tool_name: 'Bash', tool_input: { command: 'arbitrary-program' } };
    assert.deepEqual(await send('PreToolUse', event), {});
    put(cwd, path, 'after!\n'); if (mode === 'staged') git(cwd, ['add', path]);
    await send('PostToolUse', event);
    const read = { tool_name: 'Read', tool_input: { file_path: path } };
    assert.ok(denied(await send('PreToolUse', read)), mode);
    assert.deepEqual(await send('PreToolUse', read), {}); assert.equal(record(decision).status, 0);
    await send('PostToolUse', event); assert.deepEqual(await send('PreToolUse', read), {});
    await send('Stop'); assert.equal(rows()[0].edited, true);
  }
});
test('F3: gh review intent survives options and positional argument placement', async t => {
  for (const command of ['gh api --method GET repos/o/r/pulls/12/comments', 'gh api -H "Accept: application/vnd.github+json" repos/o/r/pulls/12/comments', 'gh --repo o/r pr view 12 --comments', 'gh -R o/r pr checks 12', 'gh api --hostname github.com --jq . repos/o/r/pulls/12/reviews', 'gh api --preview fixture repos/o/r/pulls/12/comments', 'gh pr view --repo=o/r --comments=true 12', 'gh run view --job 1 12 --log-failed']) {
    const { send, edit, record } = project(t); await send('UserPromptSubmit'); assert.equal(record(decision).status, 0);
    await send('PostToolUse', { tool_name: 'Bash', tool_input: { command } }); assert.ok(denied(await edit()), command);
  }
});
test('N1: each shell command owns its review flags and help request', async t => {
  for (const separator of [';', '&&', '||', '|', '\n', '\r\n']) {
    for (const [left, right, expected] of [
      ['gh pr view 12', 'echo --comments', false],
      ['echo --comments', 'gh pr view 12', false],
      ['gh pr view 12 --comments', 'echo --help', true],
      ['echo --help', 'gh pr view 12 --comments', true],
      ['gh pr view 12 --comments --help', 'echo done', false],
      ['echo done', 'gh pr view 12 --comments --help', false],
    ]) {
      const command = `${left}${separator}${right}`;
      const { send, edit, record } = project(t); await send('UserPromptSubmit'); assert.equal(record(decision).status, 0);
      await send('PostToolUse', { tool_name: 'Bash', tool_input: { command } }); assert.equal(denied(await edit()), expected, command);
    }
  }
});
test('N1: quoted separators stay within arguments and pipelines retain review intent', async t => {
  for (const [command, expected] of [
    ['echo "unrelated; gh pr view 12 --comments"', false],
    ["echo 'unrelated && gh pr view 12 --comments'", false],
    ['gh pr view 12 --repo "o/r;echo --help" --comments', true],
    ["gh pr view 12 --repo 'o/r|echo --help' --comments", true],
    ['gh api repos/o/r/pulls/12/comments | Out-String', true],
    ['gh api repos/o/r/pulls/12/comments?per_page=100|Out-String', true],
    ['python skills/code-review/scripts/run_review.py;echo --help', true],
    ['echo --help;python skills/code-review/scripts/run_review.py', true],
    ['python skills/code-review/scripts/run_review.py --help;echo done', false],
  ]) {
    const { send, edit, record } = project(t); await send('UserPromptSubmit'); assert.equal(record(decision).status, 0);
    await send('PostToolUse', { tool_name: 'exec_command', tool_input: { cmd: command } }); assert.equal(denied(await edit()), expected, command);
  }
});
test('N2: nested project shell observation resolves dirty paths from the Git root and excludes siblings', async t => {
  for (const mode of ['dirty', 'untracked', 'staged', 'sibling']) {
    const { root, cwd, send, record } = project(t, {}, true);
    const path = mode === 'untracked' ? 'new.txt' : 'README.md';
    if (mode !== 'sibling') put(cwd, path, 'before\n');
    else put(root, 'sibling.txt', 'before\n');
    if (mode === 'staged') git(cwd, ['add', path]);
    await send('UserPromptSubmit');
    const event = { tool_name: 'Bash', tool_input: { command: 'arbitrary-program' } };
    assert.deepEqual(await send('PreToolUse', event), {});
    const target = mode === 'sibling' ? resolve(root, 'sibling.txt') : resolve(cwd, path);
    const execution = spawnSync(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1], 'after!\\n')", target], { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(execution.status, 0, execution.stderr); assert.equal(get(cwd, target), 'after!\n');
    await send('PostToolUse', event);
    const read = { tool_name: 'Read', tool_input: { file_path: path } };
    assert.equal(denied(await send('PreToolUse', read)), mode !== 'sibling', mode);
    assert.deepEqual(await send('PreToolUse', read), {});
    if (mode !== 'sibling') { assert.equal(record(decision).status, 0); await send('PostToolUse', event); assert.deepEqual(await send('PreToolUse', read), {}); }
  }
});
test('F4: help and unrelated gh reads preserve the decision', async t => {
  for (const command of ['gh pr view --comments --help', 'gh api repos/o/r/pulls/12/comments --help', 'gh run view --log-failed --help', 'gh pr checks -h', 'python skills/code-review/scripts/run_review.py --help', 'py skills/code-review/scripts/run_review.py -h', 'gh pr view 12 --comments=false', 'gh api repos/o/r/issues/12/comments', 'echo "gh pr view --comments"', 'gh api -H "repos/o/r/pulls/12/comments" repos/o/r/issues/12/comments']) {
    const { send, edit, record } = project(t); await send('UserPromptSubmit'); assert.equal(record(decision).status, 0);
    await send('PostToolUse', { tool_name: 'Bash', tool_input: { command } }); assert.deepEqual(await edit(), {}, command);
  }
});
test('F5: 0.3.1 active state starts fresh and records the upgraded turn', async t => {
  const { cwd, send, edit, record, rows } = project(t); await send('UserPromptSubmit');
  const folder = resolve(cwd, '.geppetto/hook-state'), stateName = readdirSync(folder).find(name => /^review-turn-.*\.json$/.test(name));
  const state = JSON.parse(get(folder, stateName)); delete state.epoch; delete state.worktree;
  put(folder, stateName, state);
  // This is the public legacy decision representation, without the epoch/value/history envelope.
  const { createHash } = await import('node:crypto'); const hash = text => createHash('sha256').update(text).digest('hex');
  put(folder, `decision-${hash('session')}-${hash('turn')}.json`, decision);
  assert.ok(denied(await edit())); assert.equal(record(decision).status, 0);
  assert.deepEqual(await edit(), {}); assert.deepEqual(await send('Stop'), {});
  assert.equal(rows().length, 1); assert.equal(rows()[0].decisions.length, 1); assert.equal(rows()[0].requirements.changes, false);
});
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
  assert.deepEqual(await send('Stop'), {}); assert.equal(existsSync(projectDataPath(cwd, 'turns.jsonl')), false);
});
test('native file writes gate, while shell and recording commands remain available', async t => {
  for (const [tool_name, tool_input] of [['Write', {}], ['MultiEdit', {}], ['functions.apply_patch', '*** Begin Patch'], ['mcp__filesystem__write_file', {}], ['mcp.filesystem.edit_file', {}]]) {
    const { send } = project(t); assert.ok(denied(await send('PreToolUse', { tool_name, tool_input })), JSON.stringify(tool_input));
  }
  const { send } = project(t);
  for (const command of ['node hook.mjs --record-turn - --session session', 'echo "x > y"', 'rg "Set-Content" .', 'rg "writeFileSync" .', 'echo title > README.md', 'Set-Content README.md title', 'sed -i s/a/b/ README.md', 'python -c "open(\'README.md\',\'w\').write(\'title\')"']) assert.deepEqual(await send('PreToolUse', { tool_name: 'Bash', tool_input: { command } }), {});
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
    const { cwd } = project(t, { turnChecks }); const result = invoke('audit.mjs', ['--json'], { cwd }); assert.notEqual(result.status, 0); assert.match(result.stderr, /turnChecks/);
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
