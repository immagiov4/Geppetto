import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixture, git, get, put } from './helpers.mjs';
import { setupMemory } from '../skills/geppetto-adopt/scripts/memory-setup.mjs';

test('memory setup preserves a custom hook and publishes pending commits on commit', async t => {
  const home = fixture(t);
  const remote = resolve(home, 'remote.git'), localPath = resolve(home, 'memory'), project = resolve(home, 'project');
  for (const path of [remote, localPath, project]) mkdirSync(path);
  const checked = (path, args) => {
    const result = git(path, args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  checked(remote, ['init', '--bare']);
  checked(localPath, ['init', '-b', 'main']);
  const commit = message => checked(localPath, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', message]);
  checked(localPath, ['remote', 'add', 'origin', remote]);
  commit('pending');
  checked(localPath, ['config', 'core.hooksPath', 'custom hooks']);
  put(localPath, 'custom hooks/post-commit', '#!/bin/sh\n. "$(dirname "$0")/helper.sh"\n');
  put(localPath, 'custom hooks/helper.sh', 'printf "%s\\n" "${0##*/}" >> observed\n');
  chmodSync(resolve(localPath, 'custom hooks/post-commit'), 0o755);
  put(home, '.geppetto/config.json', { memory: { repo: remote, localPath } });
  await setupMemory(project, {}, { home });
  await setupMemory(project, {}, { home });
  renameSync(remote, remote + '.offline');
  const offline = git(localPath, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'offline']);
  assert.equal(offline.status, 0);
  assert.match(offline.stderr, /commit is local.*Pull with rebase/);
  renameSync(remote + '.offline', remote);
  commit('publish');
  assert.equal(checked(localPath, ['config', 'core.hooksPath']), 'custom hooks');
  assert.equal(get(localPath, 'observed').trim(), 'post-commit\npost-commit');
  assert.equal(checked(remote, ['log', '--format=%s', 'main']), 'publish\noffline\npending');
});

test('project memory opt-out does not contact an inherited checkout', async t => {
  const home = fixture(t);
  const project = resolve(home, 'project');
  put(home, '.geppetto/config.json', { memory: { choice: 'github', repo: 'unused', localPath: resolve(home, 'absent') } });
  put(project, '.geppetto/config.json', { memory: { choice: 'none' } });
  assert.equal(await setupMemory(project, {}, { home, execute: () => assert.fail('Git must not run') }), null);
});

test('setup replaces the known manual push hook without chaining it', async t => {
  const home = fixture(t);
  const remote = resolve(home, 'remote.git'), localPath = resolve(home, 'memory');
  assert.equal(git(home, ['init', '--bare', remote]).status, 0);
  assert.equal(git(home, ['init', '-b', 'main', localPath]).status, 0);
  assert.equal(git(localPath, ['remote', 'add', 'origin', remote]).status, 0);
  const manual = String.raw`#!/bin/sh
# Memory saves are published with the commit (maintainer, 2026-11-21): a commit here is also a push.
git push --quiet 2>&1 || { echo "llm-memories: push failed; the commit is local only. Run: git -C \"$(git rev-parse --show-toplevel)\" pull --rebase && git push" >&2; exit 0; }`;
  put(localPath, '.git/hooks/post-commit', manual + '\n');
  chmodSync(resolve(localPath, '.git/hooks/post-commit'), 0o755);
  put(home, '.geppetto/config.json', { memory: { repo: remote, localPath } });
  await setupMemory(home, {}, { home });
  assert.match(get(localPath, '.git/hooks/post-commit'), /Geppetto memory publication/);
  assert.throws(() => get(localPath, '.git/hooks/geppetto-previous/post-commit'), { code: 'ENOENT' });
});
