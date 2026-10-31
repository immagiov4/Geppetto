import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fixture, put, get, repo, invoke } from './helpers.mjs';
import { compileIntegrations } from '../skills/geppetto-adopt/scripts/maintenance.mjs';
import { ownSkills } from '../scripts/check-skills.mjs';

test('compiled view includes only installed companions and their applicable skill sections', async t => {
  const home = fixture(t), root = fixture(t), catalog = fixture(t);
  put(home, '.claude/skills/ponytail/SKILL.md', '# Installed');
  put(catalog, 'ponytail.md', '# Ponytail\n\n## With geppetto-build\nBuild with the smallest complete change.\n\n## With geppetto-verify\nVerify the real outcome.\n');
  put(catalog, 'absent.md', '# Absent\n\n## With geppetto-build\nABSENT_TEXT\n');
  const report = await compileIntegrations(root, { home, catalog, execute: () => ({ status: 0, stdout: '[]' }), roots: [] });
  const view = get(home, '.geppetto/integrations.md');
  assert.match(view, /## geppetto-build/); assert.match(view, /## geppetto-verify/); assert.match(view, /smallest complete change/);
  assert.doesNotMatch(view, /ABSENT_TEXT/); assert.ok(view.includes(resolve(catalog, 'ponytail.md').replaceAll('\\', '/')));
  assert.deepEqual(report.installed, ['ponytail']); assert.deepEqual(report.suggestions, ['absent']);
});

test('plugin-cache skill folders and installed CLI plugins qualify without accepting merely available plugins', async t => {
  const home = fixture(t), root = fixture(t), catalog = fixture(t);
  put(home, '.codex/plugins/cache/vendor/skill-diet/1.0/skills/skill-diet/SKILL.md', '# Installed');
  for (const name of ['skill-diet', 'TokenEconomizer', 'available']) put(catalog, name + '.md', `# ${name}\n\n## With geppetto-learn\nUse ${name}.\n`);
  const report = await compileIntegrations(root, { home, catalog, roots: [], execute: () => ({ status: 0, stdout: JSON.stringify([{ id: 'TokenEconomizer@vendor', enabled: true }, { id: 'skill-diet@vendor', installed: true }, { id: 'available@vendor', installed: false }]) }) });
  assert.deepEqual(report.installed, ['TokenEconomizer', 'skill-diet']); assert.doesNotMatch(get(home, '.geppetto/integrations.md'), /Use available/);
  const stale = await compileIntegrations(root, { home, catalog, roots: [], execute: () => ({ status: 0, stdout: '[]' }) });
  assert.deepEqual(stale.installed, []);
});

test('every Geppetto skill carries the fixed companion pointer', () => {
  for (const name of ownSkills) assert.ok(readFileSync(resolve(repo, 'skills', name, 'SKILL.md'), 'utf8').includes('If `~/.geppetto/integrations.md` has a section for this skill, read it.'), name);
});

test('generated installations retain a working catalog beside the copied skills', t => {
  const root = fixture(t), home = fixture(t);
  const result = invoke('install.mjs', ['--target', 'agents', '--project', root, '--gate-sha', 'a'.repeat(40)], { cwd: root, home });
  assert.equal(result.status, 0, result.stderr);
  assert.match(get(root, '.agents/skills/geppetto-adopt/integrations/TokenEconomizer.md'), /microskills=off/);
});

test('standalone installation preserves an existing project PR procedure instead of replacing it with the fallback', t => {
  const root = fixture(t), home = fixture(t), path = '.agents/skills/write-pr/SKILL.md';
  put(root, path, '# Maintainer PR procedure\nKeep the chosen project format.\n');
  const result = invoke('install.mjs', ['--target', 'agents', '--project', root, '--gate-sha', 'a'.repeat(40)], { cwd: root, home });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(get(root, path), '# Maintainer PR procedure\nKeep the chosen project format.\n');
  assert.equal(JSON.parse(get(root, '.geppetto/install.json')).installations.agents.files[path], undefined);
});

test('bundled PR fallback retains shared ownership across standalone targets', t => {
  const root = fixture(t), home = fixture(t), path = '.agents/skills/write-pr/SKILL.md';
  for (const target of ['agents', 'codex']) {
    const result = invoke('install.mjs', ['--target', target, '--project', root, '--gate-sha', 'a'.repeat(40)], { cwd: root, home });
    assert.equal(result.status, 0, result.stderr);
  }
  const manifest = JSON.parse(get(root, '.geppetto/install.json'));
  assert.ok(manifest.installations.agents.files[path]);
  assert.equal(manifest.installations.agents.files[path], manifest.installations.codex.files[path]);
  const result = invoke('install.mjs', ['--target', 'agents', '--project', root, '--uninstall'], { cwd: root, home });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(get(root, path), get(repo, 'skills/write-pr/SKILL.md'));
});

test('design companions resolve from project skills without activating unrelated optional principles', async t => {
  const home = fixture(t), root = fixture(t);
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = resolve(home, '.codex');
  t.after(() => { if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome; });
  for (const name of ['architect', 'codebase-design', 'engineering-workflow']) put(root, `.agents/skills/${name}/SKILL.md`, '# Installed project companion');
  const report = await compileIntegrations(root, { home, catalog: resolve(repo, 'integrations'), execute: () => ({ status: 0, stdout: '[]' }), roots: [] });
  assert.deepEqual(report.installed, ['architect', 'codebase-design', 'engineering-workflow']);
  assert.ok(report.suggestions.includes('pstack-principles'));
  const view = get(home, '.geppetto/integrations.md');
  for (const name of report.installed) assert.ok(view.includes(resolve(repo, `integrations/${name}.md`).replaceAll('\\', '/')));
  assert.ok(!view.includes(resolve(repo, 'integrations/pstack-principles.md').replaceAll('\\', '/')));
});
