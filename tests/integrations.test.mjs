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
