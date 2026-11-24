import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repo, fixture, put, get, git, invoke, config } from './helpers.mjs';

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
  assert.equal(hooks.geppetto.PreToolUse[0].hooks.length, 1);
  assert.equal(Array.isArray(hooks.geppetto.PostToolUse), true, 'PostToolUse is a grouped matcher array');
  assert.equal(hooks.geppetto.PostToolUse[0].matcher, '*');
  assert.equal(hooks.geppetto.PostToolUse[0].hooks.length, 1);
  assert.ok(template.geppetto, 'Template hooks.json defines named geppetto hook');
  assert.equal(template.geppetto.PreToolUse[0].matcher, 'edit_file|write_file');

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

  // Verify re-arm on gh pr view --comments via run_command.
  invoke('hook.mjs', ['--record-turn', JSON.stringify({
    requirements: { changes: false }, feedback: { applies: false }, frustration: { applies: false },
  }), '--session', sid], { cwd, home });
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

  // Retry with continuationActive: true lets the turn close.
  res = agHook(cwd, {
    hookEventName: 'Stop', conversationId: sid, terminationReason: 'NO_TOOL_CALL', continuationActive: true,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), {});
});

test('install.mjs supports --target antigravity in standalone and plugin-hooks modes without touching Codex trust', t => {
  const home = fixture(t);
  const project = fixture(t);
  initRepo(project);
  put(home, '.gemini/config/hooks.json', {
    'user-custom-hook': { Stop: [{ type: 'command', command: 'echo keep-me' }] },
  });

  // Standalone install writes skills under .agents/skills and merges geppetto hook into ~/.gemini/config/hooks.json.
  let res = invoke('install.mjs', ['--target', 'antigravity', '--project', project], { cwd: project, home });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(existsSync(resolve(project, '.agents/skills/geppetto-adopt/SKILL.md')), true);
  let agHooks = JSON.parse(get(home, '.gemini/config/hooks.json'));
  assert.ok(agHooks['user-custom-hook'], 'Preserves foreign hooks');
  assert.ok(agHooks.geppetto, 'Installs geppetto hook');
  assert.match(agHooks.geppetto.SessionStart[0].command, /--harness antigravity$/);

  let machine = JSON.parse(get(home, '.geppetto/machine.json'));
  assert.equal(machine.hooks.antigravity.source, resolve(home, '.gemini/config/hooks.json'));
  assert.equal(machine.hooks.codex, undefined);

  // Switching to --plugin-hooks removes duplicate .agents/skills copies and clears user-level hooks.json entry.
  res = invoke('install.mjs', ['--target', 'antigravity', '--project', project, '--plugin-hooks'], { cwd: project, home });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(existsSync(resolve(project, '.agents/skills/geppetto-adopt/SKILL.md')), false);
  agHooks = JSON.parse(get(home, '.gemini/config/hooks.json'));
  assert.ok(agHooks['user-custom-hook'], 'Still preserves foreign hooks');
  assert.equal(agHooks.geppetto, undefined, 'Removes user hook when switching to plugin hooks');
  machine = JSON.parse(get(home, '.geppetto/machine.json'));
  assert.equal(machine.hooks.antigravity.source, 'plugin');

  // Uninstall removes project ownership cleanly.
  res = invoke('install.mjs', ['--target', 'antigravity', '--project', project, '--uninstall'], { cwd: project, home });
  assert.equal(res.status, 0, res.stderr);
  machine = JSON.parse(get(home, '.geppetto/machine.json'));
  assert.equal(machine.hooks.antigravity, undefined);
});

test('learningCommand returns null for antigravity instead of falling back to claude CLI', async () => {
  const { learningCommand } = await import('../skills/geppetto-adopt/scripts/learn-runner.mjs');
  assert.equal(learningCommand('antigravity'), null);
});
