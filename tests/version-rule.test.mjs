import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const source = resolve('scripts');
test('version checks cover commits and pushes to main', () => {
 const dir = mkdtempSync(join(tmpdir(), 'version-rule-'));
 const run = (cmd, args, input) => spawnSync(cmd, args, { cwd: dir, input, encoding: 'utf8', windowsHide: true });
 const git = (...args) => { const r = run('git', args); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
 const check = (mode, input) => run(process.execPath, [join(source, 'check-version.mjs'), mode, dir], input);
 try {
  git('init', '-b', 'main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  for (const file of ['package.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.codex-plugin/plugin.json', '.agents/plugins/marketplace.json']) {
   mkdirSync(join(dir, file, '..'), { recursive: true }); writeFileSync(join(dir, file), JSON.stringify(file.includes('marketplace') ? { plugins: [{ name: 'geppetto', version: '1.0.0' }] } : { version: '1.0.0' }));
  }
  git('add', '.'); git('commit', '-m', 'base'); const base = git('rev-parse', 'HEAD'); git('switch', '-c', 'work');
  writeFileSync(join(dir, 'package.json'), '{"version":"1.0.1"}'); git('add', '.'); assert.notEqual(check('commit').status, 0);
  writeFileSync(join(dir, 'package.json'), '{"version":"1.0.0"}'); git('add', '.'); assert.equal(check('commit').status, 0);
  writeFileSync(join(dir, 'README.md'), 'docs'); git('add', '.'); git('commit', '-m', 'docs');
  const input = sha => `refs/heads/main ${sha} refs/heads/main ${base}\n`;
  assert.equal(check('push', input(git('rev-parse', 'HEAD'))).status, 0);
  mkdirSync(join(dir, 'skills')); writeFileSync(join(dir, 'skills', 'file'), 'change'); git('add', '.'); git('commit', '-m', 'shipped');
  assert.notEqual(check('push', input(git('rev-parse', 'HEAD'))).status, 0);
  assert.equal(run(process.execPath, [join(source, 'bump-version.mjs'), '1.0.1']).status, 0);
  git('add', '.'); git('commit', '-m', 'bump'); assert.equal(check('push', input(git('rev-parse', 'HEAD'))).status, 0);
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

