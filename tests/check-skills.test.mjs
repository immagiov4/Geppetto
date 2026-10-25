import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPack } from '../scripts/check-skills.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'geppetto-skills-'));
  t.after(() => {
    assert.ok(root.startsWith(`${resolve(tmpdir())}${sep}`) && basename(root).startsWith('geppetto-skills-'));
    rmSync(root, { recursive: true, force: true });
  });
  cpSync(resolve(source, 'skills'), resolve(root, 'skills'), { recursive: true });
  for (const name of ['README.md', 'THIRD_PARTY_NOTICES.md']) cpSync(resolve(source, name), resolve(root, name));
  cpSync(resolve(source, 'assets'), resolve(root, 'assets'), { recursive: true });
  return root;
}

test('complete shipped pack resolves its local reading path', t => {
  assert.deepEqual(checkPack(fixture(t)).errors, []);
});

test('a missing bundled entrypoint prevents a complete-pack claim', t => {
  const root = fixture(t);
  rmSync(resolve(root, 'skills/retro/SKILL.md'));
  assert.ok(checkPack(root).errors.some(error => error.includes('retro/SKILL.md:1: Required file missing')));
});

for (const template of ['hooks/claude/settings.json', 'hooks/codex/.codex/hooks.json', 'ci/pr-gate.yml']) {
  test(`adoption stays incomplete when its shipped ${template} is missing`, t => {
    const root = fixture(t);
    const path = `skills/geppetto-adopt/assets/templates/${template}`;
    rmSync(resolve(root, path));
    assert.ok(checkPack(root).errors.some(error => error === `${path}:1: Required file missing`));
  });
}

test('a broken procedure pointer reports its file and line', t => {
  const root = fixture(t);
  const path = resolve(root, 'skills/geppetto-build/SKILL.md');
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n[Required evidence](references/missing.md)\n`);
  assert.ok(checkPack(root).errors.some(error => error.includes('geppetto-build/SKILL.md:') && error.includes('Unresolved local link')));
});

test('an authorization template containing a grant fails closed', t => {
  const root = fixture(t);
  writeFileSync(resolve(root, 'skills/geppetto-adopt/assets/templates/authorizations'), '[publish] provider=any budget_usd=0 per=30d scope="all" expires=2099-01-01\n');
  assert.ok(checkPack(root).errors.some(error => error.includes('Authorization template must start empty')));
});

test('instruction routing detects an oversized always-loaded template', t => {
  const root = fixture(t);
  const path = resolve(root, 'skills/geppetto-adopt/assets/templates/AGENTS.md');
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n${'extra\n'.repeat(120)}`);
  assert.ok(checkPack(root).errors.some(error => error.includes('Router template must fit')));
});

test('fenced Markdown examples do not create false missing-file errors', t => {
  const root = fixture(t);
  const path = resolve(root, 'skills/geppetto-build/SKILL.md');
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n\`\`\`md\n[Example](missing.md)\n\`\`\`\n`);
  assert.deepEqual(checkPack(root).errors, []);
});
