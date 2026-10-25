import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, put, get, invoke } from './helpers.mjs';

test('instruction inventory accounts for preamble, duplicate/setext headings and fenced content', t => {
  const cwd = fixture(t);
  put(cwd, 'before.md', 'Preamble.\n\n# Rules\nFirst rule.\n\n## Same\nKeep this.\n\n```md\n## Fenced example\ncontent\n```\n\n## Same\nOther rule.\n\nSetext\n------\nLast rule.\n');
  const r = invoke('migrate-agents.mjs', ['inventory', '--source', 'before.md'], { cwd }); assert.equal(r.status, 0, r.stderr);
  const inventory = JSON.parse(r.stdout); assert.equal(inventory.sections.length, 5);
  assert.deepEqual(inventory.sections.map(s => s.title), ['Preamble', 'Rules', 'Same', 'Same', 'Setext']);
  assert.match(inventory.sections[2].content, /## Fenced example/); assert.notEqual(inventory.sections[2].id, inventory.sections[3].id);
});

test('migration requires every section content at named owners or an explicit reasoned drop', t => {
  const cwd = fixture(t); put(cwd, 'before.md', '# Rules\nKeep first.\n\nKeep second.\n\n## Obsolete\nRetired detail.\n');
  const inventory = JSON.parse(invoke('migrate-agents.mjs', ['inventory', '--source', 'before.md'], { cwd }).stdout); put(cwd, 'inventory.json', inventory);
  put(cwd, 'owner-one.md', '# Owner\nKeep first.\n'); put(cwd, 'owner-two.md', '# Owner\nKeep second.\n');
  put(cwd, 'map.json', { [inventory.sections[0].id]: { owners: ['owner-one.md', 'owner-two.md'] } });
  let r = invoke('migrate-agents.mjs', ['verify', '--inventory', 'inventory.json', '--map', 'map.json'], { cwd }); assert.equal(r.status, 1); assert.match(r.stderr, /Obsolete.*disposition/);
  const map = JSON.parse(get(cwd, 'map.json')); map[inventory.sections[1].id] = { dropped: 'Owner approved retiring this obsolete section.' }; put(cwd, 'map.json', map);
  r = invoke('migrate-agents.mjs', ['verify', '--inventory', 'inventory.json', '--map', 'map.json'], { cwd }); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /2 sections.*1 preserved.*1 intentionally dropped/);
  put(cwd, 'owner-two.md', 'Different rule.'); r = invoke('migrate-agents.mjs', ['verify', '--inventory', 'inventory.json', '--map', 'map.json'], { cwd }); assert.equal(r.status, 1); assert.match(r.stderr, /content missing.*Rules/);
  map[inventory.sections[1].id] = { dropped: '' }; put(cwd, 'map.json', map); assert.equal(invoke('migrate-agents.mjs', ['verify', '--inventory', 'inventory.json', '--map', 'map.json'], { cwd }).status, 1);
  inventory.sections.pop(); put(cwd, 'inventory.json', inventory); r = invoke('migrate-agents.mjs', ['verify', '--inventory', 'inventory.json', '--map', 'map.json'], { cwd }); assert.equal(r.status, 1); assert.match(r.stderr, /snapshot/);
});
