import { projectDataPath } from '../skills/geppetto-adopt/scripts/project-records.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync, readFileSync, mkdirSync, rmSync, rmdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixture, put, get, git } from './helpers.mjs';
import { runLearning } from '../skills/geppetto-adopt/scripts/learn-runner.mjs';

test('learning sees current permitted project files without changing the user index or retaining them as its improvement', async t => {
  const root = fixture(t), home = fixture(t);
  const command = args => { const result = git(root, args); assert.equal(result.status, 0, result.stderr); return result.stdout; };
  command(['init', '-q']); command(['config', 'user.name', 'Fixture']); command(['config', 'user.email', 'fixture@example.invalid']);
  command(['config', 'core.autocrlf', 'false']);
  put(root, '.gitignore', '.geppetto/\nignored/\n');
  put(root, 'app.mjs', 'export const behavior = "old";\n');
  put(root, 'removed.mjs', 'obsolete\n');
  put(root, 'private/fact.md', 'original private value\n');
  command(['add', '.']); command(['commit', '-qm', 'baseline']);
  const originalHead = command(['rev-parse', 'HEAD']).trim();
  put(root, 'app.mjs', 'export const behavior = "staged";\n'); command(['add', 'app.mjs']);
  put(root, 'app.mjs', 'export const behavior = "current";\n');
  put(root, 'new-owner.mjs', 'export const owner = "current untracked owner";\n');
  unlinkSync(resolve(root, 'removed.mjs'));
  put(root, 'private/fact.md', 'changed private value\n');
  put(root, '.env', 'OPENROUTER_API_KEY=synthetic-excluded\n');
  put(root, 'ignored/cache.txt', 'ignored material\n');
  put(root, '.geppetto/signals.jsonl', '{"id":"current","key":"current","session":"fixture","source":"user","category":"workflow","status":"open","text":"Use the owner of current behavior"}\n');
  const stagedBefore = command(['diff', '--cached', '--binary']);
  const indexBefore = readFileSync(resolve(root, '.git/index'));
  const result = await runLearning(root, { home, execute: async ({ cwd }) => {
    assert.equal(get(cwd, 'app.mjs'), 'export const behavior = "current";\n');
    assert.equal(get(cwd, 'new-owner.mjs'), 'export const owner = "current untracked owner";\n');
    assert.equal(existsSync(resolve(cwd, 'removed.mjs')), false);
    assert.equal(get(cwd, 'private/fact.md'), 'changed private value\n');
    assert.equal(existsSync(resolve(cwd, '.env')), false);
    assert.equal(existsSync(resolve(cwd, 'ignored/cache.txt')), false);
    put(cwd, 'lesson.md', 'Retain the demonstrated improvement.\n');
    return { decision: 'applied', reason: 'Retained the demonstrated improvement.', owner: 'lesson.md' };
  } });
  assert.equal(result.status, 'committed');
  assert.deepEqual(readFileSync(resolve(root, '.git/index')), indexBefore);
  assert.equal(result.sourceHead, originalHead);
  assert.notEqual(result.baseline, originalHead);
  assert.equal(command(['rev-parse', 'HEAD']).trim(), originalHead);
  assert.equal(command(['diff', '--cached', '--binary']), stagedBefore);
  assert.equal(get(root, 'app.mjs'), 'export const behavior = "current";\n');
  assert.equal(existsSync(resolve(root, 'lesson.md')), false);
  assert.equal(command(['diff', '--name-only', result.baseline, result.branch]).trim(), 'lesson.md');
  assert.equal(JSON.parse(get(root, projectDataPath(root, 'learning.json'))).baseline, result.baseline);
});

test('learning captures file-directory replacements in either direction, including staged replacements', async t => {
  for (const directoryFirst of [false, true]) {
    const root = fixture(t), home = fixture(t);
    const command = args => { const result = git(root, args); assert.equal(result.status, 0, result.stderr); return result.stdout; };
    command(['init', '-q']); command(['config', 'user.name', 'Fixture']); command(['config', 'user.email', 'fixture@example.invalid']);
    command(['config', 'core.autocrlf', 'false']);
    put(root, '.gitignore', '.geppetto/\n');
    put(root, directoryFirst ? 'owner/old.mjs' : 'owner', 'old owner\n');
    command(['add', '.']); command(['commit', '-qm', 'baseline']);
    const ownerPath = resolve(root, 'owner');
    if (directoryFirst) { rmSync(resolve(ownerPath, 'old.mjs')); rmdirSync(ownerPath); }
    else unlinkSync(ownerPath);
    if (!directoryFirst) mkdirSync(ownerPath);
    put(root, directoryFirst ? 'owner' : 'owner/new.mjs', 'current owner\n');
    command(['add', '-A']);
    const indexBefore = readFileSync(resolve(root, '.git/index'));
    put(root, '.geppetto/signals.jsonl', '{"id":"replacement","key":"replacement","session":"fixture","source":"user","category":"workflow","status":"open","text":"Check the current owner"}\n');
    const result = await runLearning(root, { home, execute: async ({ cwd }) => {
      assert.equal(get(cwd, directoryFirst ? 'owner' : 'owner/new.mjs'), 'current owner\n');
      if (directoryFirst) assert.equal(existsSync(resolve(cwd, 'owner/old.mjs')), false);
      return { decision: 'no_change', reason: 'The current owner already covers this case.', owner: 'owner' };
    } });
    assert.equal(result.status, 'unchanged');
    assert.deepEqual(readFileSync(resolve(root, '.git/index')), indexBefore);
  }
});

test('Git text normalization in captured files does not become a false learning improvement', async t => {
  const root = fixture(t), home = fixture(t);
  const command = args => { const result = git(root, args); assert.equal(result.status, 0, result.stderr); return result.stdout; };
  command(['init', '-q']); command(['config', 'user.name', 'Fixture']); command(['config', 'user.email', 'fixture@example.invalid']);
  command(['config', 'core.autocrlf', 'false']);
  put(root, '.gitattributes', '* text eol=lf\n');
  put(root, '.gitignore', '.geppetto/\n');
  put(root, 'app.mjs', 'export const behavior = "old";\n');
  command(['add', '.']); command(['commit', '-qm', 'baseline']);
  put(root, 'app.mjs', 'export const behavior = "current";\r\n');
  put(root, '.geppetto/signals.jsonl', '{"id":"normalized","key":"normalized","session":"fixture","source":"user","category":"workflow","status":"open","text":"Current behavior already covers the signal"}\n');
  const result = await runLearning(root, { home, execute: async ({ cwd }) => {
    assert.match(get(cwd, 'app.mjs'), /behavior = "current"/);
    return { decision: 'no_change', reason: 'Current behavior covers the signal.', owner: 'app.mjs' };
  } });
  assert.equal(result.status, 'unchanged');
  assert.equal(get(root, 'app.mjs'), 'export const behavior = "current";\r\n');
});

test('a dirty submodule is reported as excluded while ordinary current files remain available', async t => {
  const root = fixture(t), home = fixture(t);
  const command = (cwd, args) => { const result = git(cwd, args); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  const initialize = cwd => {
    command(cwd, ['init', '-q']); command(cwd, ['config', 'user.name', 'Fixture']);
    command(cwd, ['config', 'user.email', 'fixture@example.invalid']);
    command(cwd, ['config', 'core.autocrlf', 'false']);
  };
  initialize(root); mkdirSync(resolve(root, 'dependency')); initialize(resolve(root, 'dependency'));
  put(root, 'dependency/lib.txt', 'original dependency\n');
  command(resolve(root, 'dependency'), ['add', '.']); command(resolve(root, 'dependency'), ['commit', '-qm', 'dependency']);
  const dependencyHead = command(resolve(root, 'dependency'), ['rev-parse', 'HEAD']);
  put(root, '.gitignore', '.geppetto/\n'); put(root, 'app.mjs', 'old\n');
  command(root, ['add', '.gitignore', 'app.mjs']);
  command(root, ['update-index', '--add', '--cacheinfo', `160000,${dependencyHead},dependency`]);
  command(root, ['commit', '-qm', 'baseline']);
  put(root, 'dependency/lib.txt', 'dirty dependency\n'); put(root, 'app.mjs', 'current\n');
  put(root, '.geppetto/signals.jsonl', '{"id":"submodule","key":"submodule","session":"fixture","source":"user","category":"workflow","status":"open","text":"Inspect the current application"}\n');
  const indexBefore = readFileSync(resolve(root, '.git/index'));
  const result = await runLearning(root, { home, execute: async ({ cwd }) => {
    assert.equal(get(cwd, 'app.mjs'), 'current\n');
    assert.equal(existsSync(resolve(cwd, 'dependency/lib.txt')), false);
    return { decision: 'no_change', reason: 'The current application covers the signal.', owner: 'app.mjs' };
  } });
  assert.equal(result.status, 'unchanged'); assert.equal(result.excludedChanges, 1);
  assert.equal(get(root, 'dependency/lib.txt'), 'dirty dependency\n');
  assert.deepEqual(readFileSync(resolve(root, '.git/index')), indexBefore);
});
