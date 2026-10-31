import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, put, invoke, config } from './helpers.mjs';

test('section gate accepts heading icons while preserving level, body and example checks', t => {
  const cwd = fixture(t);
  put(cwd, '.geppetto/config.json', { sections: { pr: ['Observability', 'Testing'] } });
  const accepted = invoke('gate-sections.mjs', ['--pr', '-'], { cwd, input: '## 👁️ Observability\nOperation events link each request to its job.\n\n## 🧪 Testing\nThe failed-job retry scenario passes.\n' });
  assert.equal(accepted.status, 0, accepted.stderr);
  for (const input of ['### 👁️ Observability\nEvents record the job.\n', '## 👁️ Observability\n', '```markdown\n## 👁️ Observability\nExample only.\n```']) {
    assert.equal(invoke('gate-sections.mjs', ['--pr', '-'], { cwd, input: input + '\n## Testing\nThe failed-job retry scenario passes.\n' }).status, 1);
  }
});

for (const answer of ['**Not applicable**', '*Not applicable*', '`Not applicable`', 'N/A', 'n/a', '-', '.', 'TBD', 'none', '**N/A**', 'Not applicable because …']) {
  test(`required sections reject unexplained answer ${JSON.stringify(answer)}`, t => {
    const result = invoke('gate-sections.mjs', ['--pr', '-'], { cwd: fixture(t), input: `## Observability\n${answer}` });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /<stdin>:1:.*(?:Empty section|needs a reason)/);
  });
}

test('formatted non-applicability with a concrete reason passes', t => {
  const result = invoke('gate-sections.mjs', ['--pr', '-'], { cwd: fixture(t), input: '## Observability\n**Not applicable** because this changes spelling only.' });
  assert.equal(result.status, 0, result.stderr);
});

test('PR sections accept content and reject a fenced heading, an empty section, and unexplained non-applicability', t => {
  const cwd = fixture(t);
  for (const text of ['## Observability\nErrors are recorded.', 'Observability\n-------------\nNot applicable: this changes spelling only.', '## Observability\n```json\n{"event":"failure"}\n```', '<!--\n```\n-->\n## Observability\nLogs']) {
    const r = invoke('gate-sections.mjs', ['--pr', '-'], { cwd, input: text }); assert.equal(r.status, 0, r.stderr);
  }
  for (const text of ['```md\n## Observability\nLogs\n```', '~~~md\n## Observability\nLogs\n~~~', '## Observability\n<!-- TODO -->\n## Next\nElsewhere', '## Observability\nChild\n-----', '## Observability\nNot applicable']) {
    const r = invoke('gate-sections.mjs', ['--pr', '-'], { cwd, input: text }); assert.equal(r.status, 1, r.stderr); assert.match(r.stderr, /<stdin>:\d+:/);
  }
});

test('feature globs include nested files and configuration makes Verification required only when selected', t => {
  const cwd = fixture(t); put(cwd, 'docs/a.md', '## Observability\nLogs'); put(cwd, 'docs/nested/b.md', '## Observability\nMetrics');
  assert.equal(invoke('gate-sections.mjs', ['--docs', 'docs/**/*.md'], { cwd }).stdout.trim(), 'Sections OK (2 documents)');
  const cfg = config(); cfg.sections.featureDocs.push('Verification'); put(cwd, '.geppetto/config.json', cfg);
  const bad = invoke('gate-sections.mjs', ['--docs', 'docs/**/*.md'], { cwd }); assert.equal(bad.status, 1); assert.match(bad.stderr, /Missing section: Verification/);
  assert.equal(invoke('gate-sections.mjs', ['--docs', 'absent/**/*.md'], { cwd }).status, 1);
  assert.equal(invoke('gate-sections.mjs', ['--pr', '-', '--docs', 'docs/*.md'], { cwd }).status, 2);
});

test('heading examples and hostile Markdown remain inert data', t => {
  const cwd = fixture(t); const text = '## Observability\n$(touch owned) `process.exit(9)`\n```\n## Next\n```';
  const r = invoke('gate-sections.mjs', ['--pr', '-'], { cwd, input: text }); assert.equal(r.status, 0, r.stderr);
});

test('agent gate resolves Markdown and import pointers and counts imported UTF-8 bytes', t => {
  const cwd = fixture(t); put(cwd, 'AGENTS.md', '# Router\n[Rules](rules.md)\n'); put(cwd, 'rules.md', 'Rules'); put(cwd, 'CLAUDE.md', '@AGENTS.md\n@more.md\n'); put(cwd, 'more.md', 'é'.repeat(40));
  let r = invoke('gate-agents.mjs', [], { cwd }); assert.equal(r.status, 0, r.stderr);
  r = invoke('gate-agents.mjs', ['--max-bytes', '60'], { cwd }); assert.equal(r.status, 1); assert.match(r.stderr, /byte budget/);
  put(cwd, 'rules.md', 'Rules'); put(cwd, 'AGENTS.md', '# Router\n[Rules](missing.md)\n');
  r = invoke('gate-agents.mjs', [], { cwd }); assert.equal(r.status, 1); assert.match(r.stderr, /AGENTS.md:2:.*missing.md/);
});

test('agent gate fails on missing imports, cycles and excess lines, ignores remote links and fenced examples', t => {
  const cwd = fixture(t); put(cwd, 'AGENTS.md', '# Router\n[Remote](https://example.com/a)\n```\n[Example](absent.md)\n```\n');
  assert.equal(invoke('gate-agents.mjs', [], { cwd }).status, 0);
  assert.equal(invoke('gate-agents.mjs', ['--max-lines', '2'], { cwd }).status, 1);
  put(cwd, 'CLAUDE.md', '@missing.md'); assert.match(invoke('gate-agents.mjs', [], { cwd }).stderr, /CLAUDE.md:1:.*missing.md/);
  put(cwd, 'CLAUDE.md', '@cycle.md'); put(cwd, 'cycle.md', '@CLAUDE.md'); assert.match(invoke('gate-agents.mjs', [], { cwd }).stderr, /Import cycle/);
  assert.equal(invoke('gate-agents.mjs', ['--max-lines', 'zero'], { cwd }).status, 2);
});

test('the required section must be a level-two heading', t => {
  for (const text of ['# Observability\nLogs', '### Observability\nLogs', 'Observability\n=============\nLogs']) {
    const result = invoke('gate-sections.mjs', ['--pr', '-'], { cwd: fixture(t), input: text });
    assert.equal(result.status, 1, text); assert.match(result.stderr, /level-two heading/);
  }
});
