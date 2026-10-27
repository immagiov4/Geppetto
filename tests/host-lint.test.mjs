import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, put, get, invoke, config } from './helpers.mjs';

test('host lint inventories every host formatter/linter config and proposes vendored ignores', t => {
  const cwd = fixture(t);
  put(cwd, 'biome.json', { files: { includes: ['**'] } });
  put(cwd, 'config/eslint.config.mjs', 'export default [{ignores: []}];\n');
  put(cwd, 'config/eslint.sonar.config.mjs', 'export default [];\n');
  put(cwd, '.prettierrc', '{}');
  const r = invoke('host-lint.mjs', ['--json'], { cwd }); assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout); assert.equal(report.configurations.length, 4);
  assert.deepEqual(report.configurations.map(c => c.registration), Array(4).fill('proposed'));
  assert.deepEqual(report.configurations.find(c => c.tool === 'Biome').patterns, ['!!**/.agents/skills', '!!**/.geppetto']);
  assert.equal(get(cwd, 'biome.json'), '{"files":{"includes":["**"]}}'); assert.equal(report.check.status, 'not-verified');
});

test('affected-file verification fails before host registration and passes afterward without altering vendor bytes', t => {
  const cwd = fixture(t);
  put(cwd, '.geppetto/config.json', { ...config(), hostChecks: { changed: [process.execPath, 'check.mjs'] } });
  put(cwd, '.geppetto/bin/vendor.mjs', 'export const original = true;\n');
  put(cwd, 'biome.json', { files: { includes: ['**'] } });
  put(cwd, 'check.mjs', "import {readFileSync} from 'node:fs'; const patterns=JSON.parse(readFileSync('biome.json')).files.includes; process.exit(patterns.includes('!!**/.agents/skills') && patterns.includes('!!**/.geppetto') ? 0 : 1);\n");
  let r = invoke('host-lint.mjs', ['--verify', '--json'], { cwd }); assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).check.status, 'fail');
  put(cwd, 'biome.json', { files: { includes: ['**', '!!**/.agents/skills', '!!**/.geppetto'] } });
  r = invoke('host-lint.mjs', ['--verify', '--json'], { cwd }); assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).check.status, 'pass');
  assert.equal(get(cwd, '.geppetto/bin/vendor.mjs'), 'export const original = true;\n');
  put(cwd, '.geppetto/config.json', { ...config(), hostChecks: { changed: 'node check.mjs' } }); assert.equal(invoke('host-lint.mjs', ['--verify'], { cwd }).status, 1);
});

test('Biome 1 and installed Claude skill paths receive their appropriate ignore syntax', t => {
  const cwd = fixture(t); put(cwd, '.claude/skills/example/SKILL.md', 'Example');
  put(cwd, 'biome.json', { $schema: 'https://biomejs.dev/schemas/1.9.4/schema.json', files: { ignore: [] } });
  const r = invoke('host-lint.mjs', ['--json'], { cwd }); assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout); assert.deepEqual(result.configurations[0].patterns, ['.agents/skills/**', '.geppetto/**', '.claude/skills/**']); assert.match(result.configurations[0].instruction, /files.ignore/);
});
