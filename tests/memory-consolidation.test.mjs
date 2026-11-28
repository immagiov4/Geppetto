import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixture, get, put, git } from './helpers.mjs';
import { maintainMemory } from '../skills/geppetto-adopt/scripts/memory-maintenance.mjs';

import { isolatedCodexHome } from '../skills/geppetto-adopt/scripts/memory-runner.mjs';

const bucket = 'buckets/sample/';
const page = '# Guidance\n\nFollow the documented exception.\n\nSource: https://example.test/guidance\n';
const template = 'Propose bounded edits.';
function checkedGit(cwd, args) {
  const result = git(cwd, args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function setup(t, pages = { 'guidance.md': page }) {
  const home = fixture(t), cwd = fixture(t);
  checkedGit(cwd, ['init']);
  checkedGit(cwd, ['config', 'core.autocrlf', 'false']);
  checkedGit(cwd, ['config', 'user.name', 'Fixture']);
  checkedGit(cwd, ['config', 'user.email', 'fixture@example.test']);
  put(cwd, 'index.md', '# Memory\n\n| Bucket | Scope | Holds |\n| --- | --- | --- |\n| [Sample](buckets/sample/index.md) | global | Guidance |\n');
  put(cwd, bucket + 'index.md', '# Sample\n\n' + Object.keys(pages).filter(path => !path.includes('/')).map(path => '- [' + path + '](' + path + ')\n').join(''));
  for (const [path, content] of Object.entries(pages)) put(cwd, bucket + path, content);
  function commit() {
    checkedGit(cwd, ['add', '.']);
    checkedGit(cwd, ['commit', '-m', 'Fixture']);
    return head();
  }
  const head = () => checkedGit(cwd, ['rev-parse', 'HEAD']);
  const base = commit();
  const health = () => JSON.parse(get(home, '.geppetto/health.json')).checks['job:maintain-memory'];
  const job = (runner, now, options) => maintainMemory({ home, cwd, job: {}, template, runner, now, ...options });
  const log = () => get(home, '.geppetto/maintain-memory.log').trim().split('\n').map(JSON.parse);
  return { home, cwd, head, base, health, job, commit, log };
}

test('a clean initialized cursor completes without calling a runner', async t => {
  const { job, health, head } = setup(t);
  assert.equal(await job(async (_phase, stdin) => {
    const { items } = JSON.parse(stdin);
    return JSON.stringify({ items: items.map(({ id }) => ({ id, status: 'unchanged' })) });
  }), 0);
  assert.equal(await job(() => assert.fail('runner invoked for an empty scan')), 0);
  assert.equal(health().state, 'ok');
  assert.equal(health().outcome, 'no_change');
  assert.equal(health().lastRunSha[bucket.slice(0, -1)], head());
  assert.deepEqual(health().receipt.usage, { calls: 0, tokens: 0 });
});

const unchanged = items => ({ items: items.map(({ id }) => ({ id, status: 'unchanged' })) });
const jsonRunner = callback => async (phase, stdin) => ({ stdout: JSON.stringify(await callback(phase, JSON.parse(stdin))), tokens: 12 });
function rewrite(item, transform = text => text.replace('documented exception.', 'documented exception whenever it applies.')) {
  const oldText = item.blocks.map(block => block.text).join('\n\n') + '\n';
  return {
    id: item.id, status: 'rewrite', newText: transform(oldText),
    claims: item.blocks.map(({ id, text }) => ({ blockId: id, claim: text, status: 'preserved', evidenceIds: [] })),
    behaviorChange: 'The documented exception still applies in the same cases.',
  };
}
const worktrees = cwd => checkedGit(cwd, ['worktree', 'list', '--porcelain']).split('\n').filter(line => line.startsWith('worktree '));

for (const race of ['switch', 'reset']) {
  test('a concurrent ' + race + ' after checkout inspection aborts integration', async t => {
    const { cwd, base, head, commit, health, job } = setup(t);
    const index = bucket + 'index.md', original = get(cwd, index);
    const repeated = original + '- [guidance.md](guidance.md)\n';
    assert.equal(await job(jsonRunner((_, input) => unchanged(input.items))), 0);
    put(cwd, index, repeated);
    const duplicate = commit();
    const branch = checkedGit(cwd, ['symbolic-ref', 'HEAD']);
    const cursors = health().lastRunSha;
    let changed = false;
    const execute = (command, args, { cwd: root, ...options }) => {
      const result = git(root, args, options);
      if (!changed && command === 'git' && args[0] === 'ls-files') {
        if (race === 'switch') checkedGit(cwd, ['switch', '-c', 'concurrent']);
        else checkedGit(cwd, ['reset', '--hard', base]);
        changed = true;
      }
      return result;
    };
    assert.equal(await job(() => assert.fail('mechanical repair called the runner'), undefined, { execute }), 1);
    assert.equal(changed, true);
    assert.equal(health().outcome, 'retry');
    assert.deepEqual(health().lastRunSha, cursors);
    assert.equal(checkedGit(cwd, ['symbolic-ref', 'HEAD']), race === 'switch' ? 'refs/heads/concurrent' : branch);
    assert.equal(head(), race === 'switch' ? duplicate : base);
    assert.equal(checkedGit(cwd, ['rev-parse', branch]), race === 'switch' ? duplicate : base);
    assert.equal(get(cwd, index), race === 'switch' ? repeated : original);
    assert.equal(checkedGit(cwd, ['status', '--porcelain']), '');
    assert.equal(worktrees(cwd).length, 1);
  });
}

test('a configured repository mismatch is blocked before the scan and runner', async t => {
  const { home, cwd, base, head, health, job, log } = setup(t);
  put(home, '.geppetto/config.json', { memory: { localPath: cwd, repo: 'https://example.test/intended.git' } });
  checkedGit(cwd, ['remote', 'add', 'origin', 'https://example.test/foreign.git']);
  assert.equal(await job(jsonRunner((_, input) => unchanged(input.items))), 1);
  assert.equal(health().state, 'blocked');
  assert.equal(health().receipt.usage.calls, 0);
  assert.ok(!log().some(row => row.phase === 'scan'));
  assert.equal(head(), base);
});

test('index repair preserves duplicate examples inside a longer fenced code block', async t => {
  const { cwd, job, commit } = setup(t);
  const index = bucket + 'index.md', original = get(cwd, index);
  assert.equal(await job(jsonRunner((_, input) => unchanged(input.items))), 0);
  const row = '- [guidance.md](guidance.md)\n', fence = String.fromCharCode(96);
  const examples = [fence.repeat(4) + 'markdown', fence.repeat(3), row.trimEnd(), row.trimEnd(), fence.repeat(5), ''].join('\n');
  put(cwd, index, original + examples + row);
  commit();
  assert.equal(await job(() => assert.fail('mechanical repair called the runner')), 0);
  assert.equal(get(cwd, index), original + examples);
});

test('an index with duplicate rows and a broken link reaches review while another index is deduplicated', async t => {
  const { cwd, job, commit, health } = setup(t);
  const index = bucket + 'index.md', independent = 'buckets/other/index.md';
  const original = get(cwd, index), independentText = '# Other\n\n- [Other](other.md)\n';
  const duplicate = original + '- [guidance.md](guidance.md)\n';
  put(cwd, 'index.md', get(cwd, 'index.md') + '| [Other](' + independent + ') | global | Other guidance |\n');
  put(cwd, independent, independentText);
  put(cwd, 'buckets/other/other.md', page);
  commit();
  assert.equal(await job(jsonRunner((_, input) => unchanged(input.items))), 0);
  put(cwd, index, duplicate + '- [Missing](missing.md)\n');
  put(cwd, independent, independentText + '- [Other](other.md)\n');
  commit();
  assert.equal(await job(jsonRunner((phase, input) => {
    if (phase === 'reviewer') return { verdicts: input.ops.map(({ id }) => ({ id, verdict: 'approve', reason: 'The valid link remains.' })) };
    const item = input.items.find(item => item.path === index);
    assert.ok(item.findings.includes('broken_link'));
    assert.ok(item.findings.includes('duplicate_index_row'));
    return { items: input.items.map(candidate => candidate === item ? rewrite(item, () => duplicate) : { id: candidate.id, status: 'unchanged' }) };
  })), 0, JSON.stringify(health()));
  assert.equal(get(cwd, index), original);
  assert.equal(get(cwd, independent), independentText);
  assert.equal(health().receipt.usage.calls, 2);
});

test('mechanical duplicate repair uses no runner and creates one local fast-forward commit', async t => {
  const { cwd, base, head, commit, health, job, log } = setup(t);
  const index = bucket + 'index.md', original = get(cwd, index);
  assert.equal(await job(jsonRunner((_, input) => unchanged(input.items))), 0);
  put(cwd, index, original + '- [guidance.md](guidance.md)\n');
  const duplicate = commit();
  assert.notEqual(duplicate, base);
  assert.equal(await job(() => assert.fail('mechanical repair called the runner')), 0);
  assert.equal(get(cwd, index), original);
  assert.equal(checkedGit(cwd, ['rev-parse', 'HEAD^']), duplicate);
  assert.deepEqual(health().receipt.usage, { calls: 0, tokens: 0 });
  assert.equal(health().receipt.verified, true);
  assert.equal(health().lastRunSha['buckets/sample'], head());
  assert.equal(log().at(-1).commit, head());
  assert.equal(worktrees(cwd).length, 1);
});

test('dirty and staged pages are skipped and Claude files never enter the batch or commit', async t => {
  const { cwd, job, health } = setup(t, { 'guidance.md': page, 'staged.md': page, 'dirty.md': page, 'claude/guidance.md': page });
  put(cwd, bucket + 'staged.md', '# Staged change');
  checkedGit(cwd, ['add', bucket + 'staged.md']);
  put(cwd, bucket + 'dirty.md', '# Dirty change');
  const before = checkedGit(cwd, ['status', '--porcelain']);
  const stagedBlob = checkedGit(cwd, ['rev-parse', ':' + bucket + 'staged.md']);
  let guidance;
  const run = jsonRunner((phase, input) => {
    if (phase === 'reviewer') return { verdicts: input.ops.map(({ id }) => ({ id, verdict: 'approve', reason: 'Scope preserved.' })) };
    const paths = input.items.map(item => item.path);
    assert.ok(!paths.some(path => /dirty|staged|\/claude\//.test(path)));
    guidance = input.items.find(item => item.path === bucket + 'guidance.md');
    assert.ok(guidance.findings.includes('matches_read_only_claude'));
    return { items: input.items.map(item => item === guidance ? rewrite(item) : { id: item.id, status: 'unchanged' }) };
  });
  assert.equal(await job(run), 0, JSON.stringify(health()));
  assert.equal(checkedGit(cwd, ['status', '--porcelain']), before);
  assert.equal(checkedGit(cwd, ['rev-parse', ':' + bucket + 'staged.md']), stagedBlob);
  assert.equal(get(cwd, bucket + 'dirty.md'), '# Dirty change');
  assert.equal(get(cwd, bucket + 'claude/guidance.md'), page);
  assert.deepEqual(checkedGit(cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split('\n'), [bucket + 'guidance.md']);
  assert.equal(health().receipt.deferred, 2);
});

test('refused or missing proposer items fail without advancing the cursor', async t => {
  const { cwd, job, health, commit, head } = setup(t);
  assert.equal(await job(jsonRunner((_, input) => unchanged(input.items))), 0);
  const previous = health().lastRunSha;
  put(cwd, bucket + 'guidance.md', page.replace('exception.', 'specific exception.'));
  const changed = commit();
  for (const response of [() => ({ items: [] }), ({ items: [item] }) => ({ items: [{ id: item.id, status: 'refused' }] })]) {
    assert.equal(await job(jsonRunner((phase, input) => { assert.equal(phase, 'proposer'); return response(input); })), 1);
    assert.equal(health().outcome, 'incomplete');
    assert.equal(health().receipt.verified, false);
    assert.deepEqual(health().lastRunSha, previous);
    assert.equal(head(), changed);
  }
});

test('cold review approves, rejects and escalates independently in one batch', async t => {
  const { cwd, job, health, base, head, log } = setup(t, { 'a.md': page, 'b.md': page, 'c.md': page });
  let decisions;
  const runner = jsonRunner((phase, input) => {
    if (phase === 'proposer') {
      const verdictByPath = { 'a.md': 'approve', 'b.md': 'reject', 'c.md': 'needs_human' };
      const pages = input.items.filter(item => !item.path.endsWith('index.md'));
      decisions = new Map(pages.map(item => [item.id, verdictByPath[item.path.split('/').at(-1)]]));
      return { items: input.items.map(item => decisions.has(item.id) ? rewrite(item) : { id: item.id, status: 'unchanged' }) };
    }
    assert.deepEqual(Object.keys(input).sort(), ['instructions', 'ops']);
    for (const item of input.ops) assert.deepEqual(Object.keys(item).sort(), ['behaviorChange', 'claims', 'evidence', 'id', 'newText', 'oldText']);
    return { verdicts: input.ops.map(({ id }) => ({ id, verdict: decisions.get(id), reason: 'Fixture decision.' })) };
  });
  assert.equal(await job(runner), 1, JSON.stringify(health()));
  assert.match(get(cwd, bucket + 'a.md'), /whenever it applies/);
  assert.equal(get(cwd, bucket + 'b.md'), page);
  assert.equal(get(cwd, bucket + 'c.md'), page);
  assert.equal(checkedGit(cwd, ['rev-parse', 'HEAD^']), base);
  assert.equal(health().state, 'blocked');
  assert.equal(health().outcome, 'needs_human');
  assert.equal(health().pendingNotice.kind, 'blocker');
  assert.equal(health().lastRunSha['buckets/sample'], head());
  assert.deepEqual(health().receipt.usage, { calls: 2, tokens: 24 });
  assert.deepEqual(log().at(-1).verdicts.map(row => row.verdict), ['approve', 'reject', 'needs_human']);
  const notice = health().pendingNotice.id;
  assert.equal(await job(() => assert.fail('unresolved conflict was sent to the model again')), 1);
  assert.equal(health().pendingNotice.id, notice);
  assert.equal(worktrees(cwd).length, 1);
});

test('invalid rewrites cannot erase a source or introduce a broken link', async t => {
  const { cwd, base, head, job, health } = setup(t);
  for (const transform of [
    text => text.replace(/Source: .+\n/, ''),
    text => text + '\n[Broken](nonexistent.md)\n',
  ]) {
    const result = await job(jsonRunner((phase, input) => {
      assert.equal(phase, 'proposer');
      return { items: input.items.map(item => item.path.endsWith('guidance.md') ? rewrite(item, transform) : { id: item.id, status: 'unchanged' }) };
    }));
    assert.equal(result, 1);
    assert.equal(health().outcome, 'incomplete');
    assert.equal(head(), base);
    assert.equal(worktrees(cwd).length, 1);
  }
});

test('a touched path that becomes dirty aborts integration and cleans the candidate worktree', async t => {
  const { cwd, home, base, head, job, log, health } = setup(t);
  const run = jsonRunner((phase, input) => {
    if (phase === 'proposer') return { items: input.items.map(item => item.path.endsWith('guidance.md') ? rewrite(item) : { id: item.id, status: 'unchanged' }) };
    put(cwd, bucket + 'guidance.md', '# User edit during review');
    return { verdicts: input.ops.map(({ id }) => ({ id, verdict: 'approve', reason: 'Fixture approval.' })) };
  });
  assert.equal(await job(run), 1, JSON.stringify(health()));
  assert.equal(health().outcome, 'retry');
  assert.equal(health().lastRunSha, undefined);
  assert.equal(head(), base);
  assert.equal(get(cwd, bucket + 'guidance.md'), '# User edit during review');
  assert.ok(log().some(row => row.phase === 'integration'));
  assert.equal(worktrees(cwd).length, 1);
  assert.ok(!readdirSync(resolve(home, '.geppetto/worktrees')).some(name => name.startsWith('memory-run-')));
});

test('a newer HEAD established during review aborts without merging', async t => {
  const { cwd, base, head, job, health } = setup(t);
  let concurrent;
  const run = jsonRunner((phase, input) => {
    if (phase === 'proposer') return { items: input.items.map(item => item.path.endsWith('guidance.md') ? rewrite(item) : { id: item.id, status: 'unchanged' }) };
    checkedGit(cwd, ['commit', '--allow-empty', '-m', 'Concurrent commit']);
    concurrent = head();
    return { verdicts: input.ops.map(({ id }) => ({ id, verdict: 'approve', reason: 'Fixture approval.' })) };
  });
  assert.equal(await job(run), 1);
  assert.equal(health().outcome, 'retry');
  assert.notEqual(concurrent, base);
  assert.equal(head(), concurrent);
  assert.equal(get(cwd, bucket + 'guidance.md'), page);
  assert.equal(worktrees(cwd).length, 1);
});

test('a fresh Codex profile copies auth and minimal config and omits instructions, plugins and history', async t => {
  const origin = fixture(t), sandbox = fixture(t);
  put(origin, 'config.toml', 'untrusted configuration');
  put(origin, 'auth.json', { fixture: true });
  put(origin, 'AGENTS.md', 'untrusted instructions');
  put(origin, 'plugins/plugin/cache.json', {});
  put(origin, 'sessions/history.jsonl', 'untrusted history');
  await isolatedCodexHome(resolve(sandbox, 'profile'), origin);
  assert.deepEqual(readdirSync(resolve(sandbox, 'profile')).sort(), ['auth.json', 'config.toml']);
  assert.equal(get(sandbox, 'profile/config.toml'), 'cli_auth_credentials_store = "file"\n');
  assert.equal(get(sandbox, 'profile/auth.json'), get(origin, 'auth.json'));
});

test('an exact Git rename repairs the old index link mechanically', async t => {
  const { cwd, job, commit, health } = setup(t);
  assert.equal(await job(jsonRunner((_, input) => unchanged(input.items))), 0);
  checkedGit(cwd, ['mv', bucket + 'guidance.md', bucket + 'renamed.md']);
  commit();
  assert.equal(await job(() => assert.fail('exact rename used a model')), 0, JSON.stringify(health()));
  assert.match(get(cwd, bucket + 'index.md'), /\(renamed\.md\)/);
  assert.deepEqual(health().receipt.usage, { calls: 0, tokens: 0 });
});

test('the scanner finds an orphan, stale attribution and a divergent read-only counterpart', async t => {
  const guidance = '# Guidance\n\nKeep this exception. [source: [Evidence](evidence.md); added: 2026-11-20; verified: 2026-11-27]\n';
  const { cwd, job, commit } = setup(t, { 'guidance.md': guidance, 'evidence.md': page });
  assert.equal(await job(jsonRunner((_, input) => unchanged(input.items))), 0);
  put(cwd, bucket + 'evidence.md', page.replace('exception.', 'new exception.'));
  put(cwd, bucket + 'orphan.md', '# Orphan\n\nUnattributed fact.\n');
  put(cwd, bucket + 'claude/guidance.md', '# Read-only parallel advice\n');
  commit();
  assert.equal(await job(jsonRunner((phase, input) => {
    assert.equal(phase, 'proposer');
    const items = new Map(input.items.map(item => [item.path, item]));
    const original = items.get(bucket + 'guidance.md');
    assert.ok(original.findings.includes('stale_provenance'));
    assert.ok(!original.findings.includes('missing_provenance'));
    assert.ok(original.findings.includes('differs_from_read_only_claude'));
    assert.ok(original.evidence.some(item => item.kind === 'read_only_claude_comparison'));
    const orphan = items.get(bucket + 'orphan.md');
    assert.ok(orphan.findings.includes('unindexed'));
    assert.ok(orphan.findings.includes('missing_provenance'));
    assert.ok(![...items.keys()].some(path => path.includes('/claude/')));
    return unchanged(input.items);
  })), 0);
});

test('private pages enter the proposal only with explicit scope', async t => {
  const { home, cwd, job, commit } = setup(t);
  put(cwd, 'buckets/private/index.md', '# Private\n\n- [Personal](personal.md)\n');
  put(cwd, 'buckets/private/personal.md', '# Synthetic personal text\n');
  put(cwd, 'index.md', get(cwd, 'index.md') + '| [Private](buckets/private/index.md) | global | Synthetic personal data |\n');
  commit();
  assert.equal(await job(jsonRunner((phase, input) => {
    assert.equal(phase, 'proposer');
    assert.doesNotMatch(JSON.stringify(input), /private|Synthetic personal/i);
    return unchanged(input.items);
  })), 0);
  put(home, '.geppetto/config.json', { memory: { buckets: ['private'] } });
  assert.equal(await job(jsonRunner((phase, input) => {
    assert.equal(phase, 'proposer');
    assert.ok(input.items.length);
    assert.ok(input.items.every(item => item.path.startsWith('buckets/private/')));
    return unchanged(input.items);
  })), 0);
});

test('rejected prerequisite leaves dependent approved changes out of the commit', async t => {
  const { cwd, job, health } = setup(t, { 'a.md': page, 'b.md': page, 'c.md': page });
  const verdicts = new Map();
  const runner = jsonRunner((phase, input) => {
    if (phase === 'reviewer') return { verdicts: input.ops.map(({ id }) => ({ id, verdict: verdicts.get(id), reason: 'Fixture decision.' })) };
    return { items: input.items.map(item => {
      if (item.path.endsWith('/a.md')) {
        verdicts.set(item.id, 'reject');
        return rewrite(item, text => text + '\nSuperseded 2026-11-28 by [B](b.md)\n');
      }
      if (item.path.endsWith('/index.md')) {
        verdicts.set(item.id, 'approve');
        return rewrite(item, text => text.replace('- [a.md](a.md)', '- [B](b.md)'));
      }
      if (item.path.endsWith('/c.md')) {
        verdicts.set(item.id, 'approve');
        return rewrite(item);
      }
      return { id: item.id, status: 'unchanged' };
    }) };
  });
  assert.equal(await job(runner), 0, JSON.stringify(health()));
  assert.equal(get(cwd, bucket + 'a.md'), page);
  assert.match(get(cwd, bucket + 'index.md'), /\(a\.md\)/);
  assert.match(get(cwd, bucket + 'c.md'), /whenever it applies/);
  assert.equal(health().receipt.verdicts.filter(row => row.applied === false).length, 1);
});
