import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { repo, fixture, put, get, git, invoke, config, restoreEnv } from './helpers.mjs';

const readJson = path => JSON.parse(readFileSync(resolve(repo, path), 'utf8'));

function initRepo(dir, files = {}) {
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  put(dir, 'README.md', '# Sample\n');
  for (const [name, content] of Object.entries(files)) put(dir, name, content);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
}

function agHook(cwd, payload, options = {}) {
  return invoke('hook.mjs', options.explicitHarness === false ? [] : ['--harness', 'antigravity'], {
    cwd,
    home: options.home ?? cwd,
    input: JSON.stringify({ cwd, ...payload }),
    env: options.env,
  });
}

test('Antigravity root manifests and template follow native plugin and hook contracts', t => {
  const cwd = fixture(t);
  const pkg = readJson('package.json');
  const plugin = readJson('plugin.json');
  const hooks = readJson('hooks.json');
  const template = readJson('skills/geppetto-adopt/assets/templates/hooks/antigravity/hooks.json');

  assert.equal(plugin.name, 'geppetto');
  assert.equal(plugin.version, pkg.version);
  assert.ok(hooks.geppetto, 'Root hooks.json defines named geppetto hook');
  for (const flatEvent of ['SessionStart', 'PreInvocation', 'Stop']) {
    assert.equal(Array.isArray(hooks.geppetto[flatEvent]), true, `${flatEvent} is a flat handler array`);
    assert.equal(hooks.geppetto[flatEvent].length, 1);
  }
  assert.equal(Array.isArray(hooks.geppetto.PreToolUse), true, 'PreToolUse is a grouped matcher array');
  assert.equal(hooks.geppetto.PreToolUse[0].matcher, 'edit_file|write_file');
  assert.equal(new RegExp(hooks.geppetto.PreToolUse[0].matcher).test('edit_file'), true);
  assert.equal(new RegExp(hooks.geppetto.PreToolUse[0].matcher).test('run_command'), false);
  assert.equal(hooks.geppetto.PreToolUse[0].hooks.length, 1);
  assert.equal(Array.isArray(hooks.geppetto.PostToolUse), true, 'PostToolUse is a grouped matcher array');
  assert.equal(hooks.geppetto.PostToolUse[0].matcher, '.*');
  assert.equal(new RegExp(hooks.geppetto.PostToolUse[0].matcher).test('run_command'), true);
  assert.equal(hooks.geppetto.PostToolUse[0].hooks.length, 1);
  assert.ok(template.geppetto, 'Template hooks.json defines named geppetto hook');
  assert.equal(template.geppetto.PreToolUse[0].matcher, 'edit_file|write_file');
  assert.equal(template.geppetto.PostToolUse[0].matcher, '.*');

  const cmd = hooks.geppetto.PreToolUse[0].hooks[0].command;
  assert.match(cmd, /^node \.\/skills\/geppetto-adopt\/scripts\/hook\.mjs --harness antigravity$/);
  const res = agHook(cwd, {
    hookEventName: 'PreToolUse',
    conversationId: 'manifest-probe',
    toolCall: { id: 'tc-1', name: 'edit_file', args: { Path: 'README.md' } },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), { decision: 'allow' });
});

test('Antigravity SessionStart injects memory index and turn schema via injectSteps with harness attribution', t => {
  const home = fixture(t);
  const cwd = fixture(t);
  initRepo(cwd);
  const mem = fixture(t);
  git(mem, ['init', '-q']);
  put(mem, 'index.md', '# Buckets\n\n| Bucket | Scope | Holds |\n|---|---|---|\n| [preferences](buckets/preferences/index.md) | global | User preferences. |\n| [sample](buckets/sample/index.md) | project | Sample project notes. |\n');
  put(mem, 'buckets/preferences/index.md', '# Preferences\n');
  put(mem, 'buckets/sample/index.md', '# Sample\n- [Guide](guide.md)\n');
  put(home, '.geppetto/config.json', { version: 1, memory: { repo: mem, localPath: mem } });
  put(cwd, '.geppetto/config.json', { ...config(), memory: { buckets: ['sample'] } });

  // Also verifies auto-detection from camelCase Antigravity payload when --harness flag is omitted.
  const res = agHook(cwd, {
    hookEventName: 'SessionStart',
    conversationId: 'ag-session-1',
    workspacePaths: [cwd],
  }, { home, explicitHarness: false });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput, undefined);
  assert.equal(Array.isArray(out.injectSteps), true);
  const injected = out.injectSteps[0]?.systemMessage?.systemMessage ?? '';
  assert.match(injected, /PROJECT bucket index \(sample\):/);
  assert.match(injected, /--record-turn/);

  const events = get(cwd, '.git/geppetto/hook-events.jsonl').trim().split('\n').map(JSON.parse);
  assert.ok(events.some(e => e.hook === 'memory' && e.harness === 'antigravity' && e.sessionId === 'ag-session-1'));
  assert.ok(events.some(e => e.hook === 'turnContext' && e.harness === 'antigravity' && e.sessionId === 'ag-session-1'));
});

test('Antigravity PreToolUse gates edits with deny, returns explicit allow on pass, and delivers advisory context via PreInvocation', t => {
  const cwd = fixture(t);
  initRepo(cwd, { 'src/app.js': 'export const x = 1;\n' });
  put(cwd, '.geppetto/config.json', config());
  const transcript = resolve(cwd, 'transcript.jsonl');
  put(cwd, 'transcript.jsonl', JSON.stringify({
    step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE',
    content: '<USER_REQUEST>\nUpdate app.js\n</USER_REQUEST>',
  }) + '\n');

  const sid = 'ag-edit-gate';
  let res = agHook(cwd, {
    hookEventName: 'PreInvocation',
    conversationId: sid,
    transcriptPath: transcript,
    invocationNum: 1,
    lastUserInput: 'Update app.js',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), {});

  // Unrecorded edit_file must be denied with Antigravity schema.
  res = agHook(cwd, {
    hookEventName: 'PreToolUse',
    conversationId: sid,
    transcriptPath: transcript,
    toolCall: { id: 'e1', name: 'edit_file', args: { Path: 'src/app.js', Target: '1', Replacement: '2' } },
  });
  assert.equal(res.status, 0, res.stderr);
  const denied = JSON.parse(res.stdout);
  assert.equal(denied.decision, 'deny');
  assert.match(denied.reason, /--record-turn/);

  // Record turn decision and verify subsequent edit_file returns explicit { decision: 'allow' }.
  const rec = invoke('hook.mjs', ['--record-turn', JSON.stringify({
    requirements: { changes: false },
    feedback: { applies: false },
    frustration: { applies: false },
  }), '--session', sid], { cwd });
  assert.equal(rec.status, 0, rec.stderr);

  res = agHook(cwd, {
    hookEventName: 'PreToolUse',
    conversationId: sid,
    transcriptPath: transcript,
    toolCall: { id: 'e2', name: 'edit_file', args: { Path: 'src/app.js', Target: '1', Replacement: '2' } },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), { decision: 'allow' });

  // Advisory PR feedback on gh pr create returns explicit allow and delivers via PreInvocation.
  res = agHook(cwd, {
    hookEventName: 'PreToolUse',
    conversationId: sid,
    transcriptPath: transcript,
    toolCall: { id: 'pr1', name: 'run_command', args: { CommandLine: "gh pr create --body '## Summary'" } },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), { decision: 'allow' });

  res = agHook(cwd, {
    hookEventName: 'PreInvocation',
    conversationId: sid,
    transcriptPath: transcript,
    invocationNum: 2,
    lastUserInput: 'Update app.js',
  });
  assert.equal(res.status, 0, res.stderr);
  const delivered = JSON.parse(res.stdout);
  assert.match(delivered.injectSteps[0]?.systemMessage?.systemMessage ?? '', /Missing section: Observability/);

  // Second PreInvocation without new queued context returns {} (drained once).
  res = agHook(cwd, {
    hookEventName: 'PreInvocation',
    conversationId: sid,
    transcriptPath: transcript,
    invocationNum: 3,
    lastUserInput: 'Update app.js',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), {});
});

test('Antigravity PostToolUse returns {}, logs reads and metrics, re-arms on review commands, and queues learnNudge for PreInvocation', t => {
  const home = fixture(t);
  const cwd = fixture(t);
  initRepo(cwd, { 'src/app.js': 'export const a = 1;\n', 'skills/demo/SKILL.md': '---\nname: demo\ndescription: demo\n---\n' });
  put(cwd, '.geppetto/config.json', {
    ...config(),
    hooks: {
      reviewGate: { enabled: true, benchmark: null, threshold: 30 },
      learnNudge: { enabled: true, benchmark: null, minToolCalls: 2, minDurationMs: 300000 },
      signalLearning: { enabled: true, benchmark: null, minSessions: 2, maxOpenKeys: 5 },
    },
  });
  const transcript = resolve(cwd, 'transcript.jsonl');
  put(cwd, 'transcript.jsonl', JSON.stringify({
    step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Run tests',
  }) + '\n');

  const sid = 'ag-post-tool';
  agHook(cwd, { hookEventName: 'PreInvocation', conversationId: sid, transcriptPath: transcript, invocationNum: 1 }, { home });

  // Tool 1: read_file on SKILL.md (PostToolUse only, matching narrowed PreToolUse matcher)
  let res = agHook(cwd, {
    hookEventName: 'PostToolUse', conversationId: sid, transcriptPath: transcript,
    toolCall: { id: 'r1', name: 'read_file', args: { Path: resolve(cwd, 'skills/demo/SKILL.md') } },
  }, { home });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), {});

  // Mid-turn PreInvocation must NOT reset tool call count!
  res = agHook(cwd, { hookEventName: 'PreInvocation', conversationId: sid, transcriptPath: transcript, invocationNum: 2 }, { home });
  assert.deepEqual(JSON.parse(res.stdout), {});

  // Tool 2: run_command npm test (qualifies minToolCalls=2 learnNudge even with PostToolUse-only tracking, plus duration metrics when paired)
  agHook(cwd, {
    hookEventName: 'PreToolUse', conversationId: sid, transcriptPath: transcript,
    toolCall: { id: 'cmd1', name: 'run_command', args: { CommandLine: 'npm test' } },
  }, { home });
  res = agHook(cwd, {
    hookEventName: 'PostToolUse', conversationId: sid, transcriptPath: transcript,
    toolCall: { id: 'cmd1', name: 'run_command', args: { CommandLine: 'npm test' } },
  }, { home });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), {});

  // Next PreInvocation delivers the queued learnNudge via injectSteps!
  res = agHook(cwd, { hookEventName: 'PreInvocation', conversationId: sid, transcriptPath: transcript, invocationNum: 3 }, { home });
  assert.equal(res.status, 0, res.stderr);
  const nudged = JSON.parse(res.stdout);
  assert.match(nudged.injectSteps[0]?.systemMessage?.systemMessage ?? '', /\$geppetto-learn/);

  // Verify reads.jsonl and metrics.jsonl recorded the Antigravity tool calls.
  const reads = get(cwd, '.git/geppetto/reads.jsonl').trim().split('\n').map(JSON.parse);
  assert.ok(reads.some(r => r.kind === 'skill' && r.harness === 'antigravity'));
  const metrics = get(cwd, '.git/geppetto/metrics.jsonl').trim().split('\n').map(JSON.parse);
  assert.ok(metrics.some(m => m.kind === 'suite' && m.key === 'npm test' && m.harness === 'antigravity'));

  // Verify failed feedback lookup (error set) does NOT re-arm feedback, while successful lookup DOES.
  invoke('hook.mjs', ['--record-turn', JSON.stringify({
    requirements: { changes: false }, feedback: { applies: false }, frustration: { applies: false },
  }), '--session', sid], { cwd, home });
  agHook(cwd, {
    hookEventName: 'PostToolUse', conversationId: sid, transcriptPath: transcript,
    toolCall: { id: 'gh-fail', name: 'run_command', args: { CommandLine: 'gh pr view --comments' } },
    error: 'exit status 1',
  }, { home });
  res = agHook(cwd, {
    hookEventName: 'PreToolUse', conversationId: sid, transcriptPath: transcript,
    toolCall: { id: 'e-after-fail', name: 'edit_file', args: { Path: 'src/app.js' } },
  }, { home });
  assert.deepEqual(JSON.parse(res.stdout), { decision: 'allow' });

  agHook(cwd, {
    hookEventName: 'PostToolUse', conversationId: sid, transcriptPath: transcript,
    toolCall: { id: 'gh1', name: 'run_command', args: { CommandLine: 'gh pr view --comments' } },
  }, { home });
  const events = get(cwd, '.git/geppetto/hook-events.jsonl').trim().split('\n').map(JSON.parse);
  assert.ok(events.some(e => e.hook === 'turnGate' && e.status === 'rearmed'));
});

test('Antigravity transcript detects new USER_EXPLICIT USER_INPUT and ignores SYSTEM_MESSAGE', t => {
  const cwd = fixture(t);
  initRepo(cwd, { 'src/app.js': 'export const a = 1;\n' });
  put(cwd, '.geppetto/config.json', config());
  const transcript = resolve(cwd, 'transcript.jsonl');
  put(cwd, 'transcript.jsonl', JSON.stringify({
    step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'First prompt',
  }) + '\n');

  const sid = 'ag-transcript';
  agHook(cwd, { hookEventName: 'PreInvocation', conversationId: sid, transcriptPath: transcript, invocationNum: 1 });
  invoke('hook.mjs', ['--record-turn', JSON.stringify({
    requirements: { changes: false }, feedback: { applies: false }, frustration: { applies: false },
  }), '--session', sid], { cwd });

  // Append a SYSTEM_MESSAGE: must NOT renew decision epoch.
  appendFileSync(transcript, JSON.stringify({
    step_index: 1, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'Reminder',
  }) + '\n');
  let res = agHook(cwd, {
    hookEventName: 'PreToolUse', conversationId: sid, transcriptPath: transcript,
    toolCall: { id: 'e1', name: 'edit_file', args: { Path: 'src/app.js' } },
  });
  assert.deepEqual(JSON.parse(res.stdout), { decision: 'allow' });

  // Append a new USER_EXPLICIT USER_INPUT: MUST renew epoch and require a fresh decision before editing.
  appendFileSync(transcript, JSON.stringify({
    step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Second prompt',
  }) + '\n');
  res = agHook(cwd, {
    hookEventName: 'PreToolUse', conversationId: sid, transcriptPath: transcript,
    toolCall: { id: 'e2', name: 'edit_file', args: { Path: 'src/app.js' } },
  });
  assert.equal(JSON.parse(res.stdout).decision, 'deny');
});

test('Antigravity Stop translates block to continue, respects continuationActive, and skips non-normal terminations', t => {
  const cwd = fixture(t);
  initRepo(cwd, { 'src/app.js': 'export const x = 0;\n' });
  put(cwd, '.geppetto/config.json', {
    ...config(),
    hooks: {
      reviewGate: { enabled: true, benchmark: null, threshold: 5 },
      learnNudge: { enabled: false, benchmark: null },
      signalLearning: { enabled: false, benchmark: null },
    },
  });
  const sid = 'ag-stop';
  agHook(cwd, { hookEventName: 'PreInvocation', conversationId: sid, invocationNum: 1 });
  put(cwd, 'src/app.js', Array.from({ length: 12 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n');

  // USER_CANCELED must never force continuation.
  let res = agHook(cwd, {
    hookEventName: 'Stop', conversationId: sid, terminationReason: 'USER_CANCELED', continuationActive: false,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), {});

  // Normal NO_TOOL_CALL with large unreviewed diff returns decision: 'continue'.
  res = agHook(cwd, {
    hookEventName: 'Stop', conversationId: sid, terminationReason: 'NO_TOOL_CALL', continuationActive: false,
  });
  assert.equal(res.status, 0, res.stderr);
  const blocked = JSON.parse(res.stdout);
  assert.equal(blocked.decision, 'continue');
  assert.match(blocked.reason, /\$geppetto-verify/);

  // Fresh turn with NO prior Stop block marker proves continuationActive: true itself suppresses blocking.
  const freshSid = 'ag-stop-continuation';
  agHook(cwd, { hookEventName: 'PreInvocation', conversationId: freshSid, invocationNum: 0 });
  put(cwd, 'src/app.js', Array.from({ length: 24 }, (_, i) => `export const f${i} = ${i};`).join('\n') + '\n');
  res = agHook(cwd, {
    hookEventName: 'Stop', conversationId: freshSid, terminationReason: 'NO_TOOL_CALL', continuationActive: true,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), {});
});

test('Antigravity repeated PreInvocation keeps review baseline when turnChecks and learnNudge are disabled, and cancellation clears queued reminders', t => {
  const cwd = fixture(t);
  initRepo(cwd, { 'src/app.js': 'export const x = 0;\n' });
  put(cwd, '.geppetto/config.json', {
    ...config(),
    turnChecks: [],
    hooks: {
      reviewGate: { enabled: true, benchmark: null, threshold: 5 },
      learnNudge: { enabled: false, benchmark: null },
      signalLearning: { enabled: false, benchmark: null },
    },
  });
  const transcript = resolve(cwd, 'transcript.jsonl');
  put(cwd, 'transcript.jsonl', JSON.stringify({
    step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Big edit',
  }) + '\n');

  const sid = 'ag-review-baseline';
  agHook(cwd, { hookEventName: 'PreInvocation', conversationId: sid, transcriptPath: transcript, invocationNum: 0 });
  put(cwd, 'src/app.js', Array.from({ length: 12 }, (_, i) => `export const b${i} = ${i};`).join('\n') + '\n');
  // Second PreInvocation on same transcript must NOT advance snapshot to the already-edited tree.
  agHook(cwd, { hookEventName: 'PreInvocation', conversationId: sid, transcriptPath: transcript, invocationNum: 1 });
  const stopRes = agHook(cwd, {
    hookEventName: 'Stop', conversationId: sid, transcriptPath: transcript, terminationReason: 'NO_TOOL_CALL', continuationActive: false,
  });
  assert.equal(stopRes.status, 0, stopRes.stderr);
  assert.equal(JSON.parse(stopRes.stdout).decision, 'continue');

  // Cancellation clears any queued reminder so the next turn never receives stale advice.
  const cwd2 = fixture(t);
  initRepo(cwd2, { 'src/app.js': 'export const y = 0;\n' });
  put(cwd2, '.geppetto/config.json', {
    ...config(),
    hooks: {
      reviewGate: { enabled: true, benchmark: null, threshold: 30 },
      learnNudge: { enabled: true, benchmark: null, minToolCalls: 1, minDurationMs: 300000 },
      signalLearning: { enabled: true, benchmark: null, minSessions: 2, maxOpenKeys: 5 },
    },
  });
  const t2 = resolve(cwd2, 'transcript.jsonl');
  put(cwd2, 'transcript.jsonl', JSON.stringify({
    step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Canceled task',
  }) + '\n');
  const cancelSid = 'ag-cancel-queue';
  agHook(cwd2, { hookEventName: 'PreInvocation', conversationId: cancelSid, transcriptPath: t2, invocationNum: 0 });
  agHook(cwd2, {
    hookEventName: 'PostToolUse', conversationId: cancelSid, transcriptPath: t2,
    toolCall: { id: 'c1', name: 'read_file', args: { Path: 'README.md' } },
  });
  agHook(cwd2, { hookEventName: 'Stop', conversationId: cancelSid, transcriptPath: t2, terminationReason: 'USER_CANCELED' });
  appendFileSync(t2, JSON.stringify({
    step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'New task',
  }) + '\n');
  const nextRes = agHook(cwd2, { hookEventName: 'PreInvocation', conversationId: cancelSid, transcriptPath: t2, invocationNum: 0 });
  assert.equal(nextRes.status, 0, nextRes.stderr);
  assert.deepEqual(JSON.parse(nextRes.stdout), {});
});

test('install.mjs supports --target antigravity in project, user and plugin-hooks modes while preserving user handlers inside geppetto map', t => {
  const home = fixture(t);
  const project = fixture(t);
  initRepo(project);
  put(home, '.gemini/config/hooks.json', {
    'user-custom-hook': { Stop: [{ type: 'command', command: 'echo keep-me' }] },
    geppetto: {
      PostInvocation: [{ type: 'command', command: 'echo keep-user-post-invocation' }],
      Stop: [{ type: 'command', command: 'echo keep-user-stop' }],
    },
  });

  // Standalone project install writes skills under .agents/skills and merges geppetto hook into ~/.gemini/config/hooks.json.
  let res = invoke('install.mjs', ['--target', 'antigravity', '--project', project], { cwd: project, home });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(existsSync(resolve(project, '.agents/skills/geppetto-adopt/SKILL.md')), true);
  let agHooks = JSON.parse(get(home, '.gemini/config/hooks.json'));
  assert.ok(agHooks['user-custom-hook'], 'Preserves foreign top-level hooks');
  assert.ok(agHooks.geppetto, 'Installs geppetto hook');
  assert.equal(agHooks.geppetto.PostInvocation?.[0]?.command, 'echo keep-user-post-invocation', 'Preserves foreign handler inside geppetto map');
  assert.ok(agHooks.geppetto.Stop.some(h => h.command === 'echo keep-user-stop'), 'Preserves foreign Stop handler inside geppetto map');
  assert.match(agHooks.geppetto.SessionStart[0].command, /--harness antigravity$/);

  let machine = JSON.parse(get(home, '.geppetto/machine.json'));
  assert.equal(machine.hooks.antigravity.source, resolve(home, '.gemini/config/hooks.json'));
  assert.equal(machine.hooks.codex, undefined);

  // Switching to --plugin-hooks removes duplicate .agents/skills copies and removes only owned commands from geppetto map.
  res = invoke('install.mjs', ['--target', 'antigravity', '--project', project, '--plugin-hooks'], { cwd: project, home });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(existsSync(resolve(project, '.agents/skills/geppetto-adopt/SKILL.md')), false);
  agHooks = JSON.parse(get(home, '.gemini/config/hooks.json'));
  assert.ok(agHooks['user-custom-hook'], 'Still preserves foreign top-level hooks');
  assert.equal(agHooks.geppetto.PostInvocation?.[0]?.command, 'echo keep-user-post-invocation', 'Still preserves foreign handler inside geppetto map');
  assert.equal(agHooks.geppetto.SessionStart, undefined, 'Removes owned geppetto handlers when switching to plugin hooks');
  machine = JSON.parse(get(home, '.geppetto/machine.json'));
  assert.equal(machine.hooks.antigravity.source, 'plugin');

  // Uninstall removes project ownership cleanly.
  res = invoke('install.mjs', ['--target', 'antigravity', '--project', project, '--uninstall'], { cwd: project, home });
  assert.equal(res.status, 0, res.stderr);
  machine = JSON.parse(get(home, '.geppetto/machine.json'));
  assert.equal(machine.hooks.antigravity, undefined);

  // User-level standalone install places skills in Antigravity's native ~/.gemini/config/skills directory.
  const userHomeDir = fixture(t);
  res = invoke('install.mjs', ['--target', 'antigravity', '--user'], { cwd: userHomeDir, home: userHomeDir });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(existsSync(resolve(userHomeDir, '.gemini/config/skills/geppetto-adopt/SKILL.md')), true);
  assert.equal(existsSync(resolve(userHomeDir, '.agents/skills/geppetto-adopt/SKILL.md')), false);
  res = invoke('install.mjs', ['--target', 'antigravity', '--user', '--uninstall'], { cwd: userHomeDir, home: userHomeDir });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(existsSync(resolve(userHomeDir, '.gemini/config/skills/geppetto-adopt/SKILL.md')), false);
});

test('Antigravity maintenance avoids Claude fallback, preserves orphan OS jobs, and avoids persistent update-notice drift', async t => {
  const { learningCommand } = await import('../skills/geppetto-adopt/scripts/learn-runner.mjs');
  const { scheduleMaintenance, maintenanceLauncherText } = await import('../skills/geppetto-adopt/scripts/maintenance.mjs');
  const { updateNotice } = await import('../skills/geppetto-adopt/scripts/update-check.mjs');

  // 1. Supply a synthetic Claude CLI on PATH to prove learningCommand('antigravity') does not fall back to it.
  const fakeBin = fixture(t);
  put(fakeBin, 'node_modules/@anthropic-ai/claude-code/cli.js', 'console.log("claude");\n');
  const envSnapshot = { ...process.env };
  try {
    process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH ?? ''}`;
    assert.ok(learningCommand('claude'), 'Synthetic Claude CLI is discoverable on PATH');
    assert.equal(learningCommand('antigravity'), null, 'Antigravity never falls back to Claude CLI');
  } finally {
    restoreEnv(envSnapshot);
  }

  // 2. Existing orphan cron / Windows OS jobs are preserved (throw rather than returning null) when previous.id is missing.
  const home = fixture(t);
  const source = { path: repo };
  const cronWithOrphan = (cmd, args) => cmd === 'crontab' && args[0] === '-l'
    ? { status: 0, stdout: '0 9 * * 1 /usr/bin/node /tmp/launcher.mjs --run curate-skills # Geppetto-curate-skills\n' }
    : { status: 0, stdout: '' };
  await assert.rejects(
    scheduleMaintenance('curate-skills', { home, host: 'antigravity', source, platform: 'linux', execute: cronWithOrphan, command: null }),
    /Install antigravity CLI/,
  );
  const cronEmpty = (cmd, args) => cmd === 'crontab' && args[0] === '-l'
    ? { status: 1, stderr: 'no crontab for user' }
    : { status: 0, stdout: '' };
  assert.equal(
    await scheduleMaintenance('curate-skills', { home, host: 'antigravity', source, platform: 'linux', execute: cronEmpty, command: null }),
    null,
  );
  const winWithOrphan = (cmd, args) => {
    if (cmd === 'powershell.exe') return { status: 0, stdout: '' };
    if (cmd === 'schtasks.exe') return { status: 0, stdout: '<Task><Settings><Enabled>true</Enabled></Settings><Actions><Exec><Command>wscript.exe</Command><Arguments>old</Arguments></Exec></Actions></Task>' };
    return { status: 0, stdout: '' };
  };
  await assert.rejects(
    scheduleMaintenance('curate-skills', { home, host: 'antigravity', source, platform: 'win32', execute: winWithOrphan, command: null }),
    /Install antigravity CLI/,
  );

  // 3. Antigravity-only installation with expected needs-scheduler produces no false repair notice on startup.
  const agHome = fixture(t);
  const project = fixture(t);
  initRepo(project);
  const pkg = readJson('package.json');
  const now = () => Date.parse('2026-11-24T12:00:00Z');
  const epoch = Math.floor(now() / 86_400_000);
  put(project, '.geppetto/config.json', { ...config(), ci: { enabled: false }, maintenance: { enabled: true } });
  put(project, '.geppetto/install.json', { version: 1, source: { path: repo, version: pkg.version }, installations: { antigravity: { files: {}, generated: [], plugin: true } } });
  put(agHome, '.geppetto/bin/maintenance-launcher.mjs', maintenanceLauncherText(agHome, { path: repo }));
  put(agHome, '.geppetto/machine.json', {
    projects: { [project]: { antigravity: repo } },
    hooks: { antigravity: { source: 'plugin' } },
    jobs: {
      'curate-skills': { status: 'needs-scheduler', source: 'skills/geppetto-adopt/assets/templates/jobs/curate-skills.md' },
      'maintain-memory': { status: 'needs-scheduler', source: 'skills/geppetto-adopt/assets/templates/jobs/maintain-memory.md' },
    },
  });
  put(agHome, '.geppetto/update-status.json', { epoch, version: pkg.version, tag: `v${pkg.version}`, sha: 'a'.repeat(40), scheduler: {} });
  const notice = await updateNotice(project, { home: agHome, now, harness: 'antigravity' });
  assert.equal(notice, '');
});
