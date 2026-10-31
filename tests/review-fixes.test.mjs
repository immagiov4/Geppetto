import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fixture, put, get, git, config } from './helpers.mjs';
import { recordSignal, signalArchive, eligibleSignals, localRecords, maintainEvidence } from '../skills/geppetto-adopt/scripts/signal.mjs';
import { learningAudit } from '../skills/geppetto-adopt/scripts/audit.mjs';
import { logReads } from '../skills/geppetto-adopt/scripts/hook-events.mjs';
import { learningFileTool } from '../skills/geppetto-adopt/scripts/learner-tools.mjs';
import { runLearning } from '../skills/geppetto-adopt/scripts/learn-runner.mjs';
import { validateConfig } from '../skills/geppetto-adopt/scripts/common.mjs';

const rows = records => records.map(JSON.stringify).join('\n') + '\n';
const observation = (key, extra = {}) => ({ key, session: 'session', category: 'workflow', text: 'Synthetic correction', ...extra });
const readEvent = (root, path) => ({ cwd: root, session_id: 'reads', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { path }, tool_response: { text: 'Synthetic content' } });

test('R1: same-session user corrections are retained and qualify immediately without inflating sessions', async t => {
  const root = fixture(t), starts = [], launch = async event => starts.push(event);
  await recordSignal(root, observation('same-problem'), { launch });
  put(root, '.geppetto/turns.jsonl', rows([{ sessionId: 'session', turnId: 'correction', feedback: { applies: true } }]));
  for (const text of ['First user correction', 'Further user correction']) {
    const entry = await recordSignal(root, observation('same-problem', { text, source: 'user', turn: 'correction' }), { launch });
    assert.equal(entry.source, 'user');
  }
  assert.deepEqual((await localRecords(root, 'signals')).map(row => row.text), ['Synthetic correction', 'First user correction', 'Further user correction']);
  const [entry] = await signalArchive(root);
  assert.equal(entry.source, 'user'); assert.deepEqual(entry.sessions, ['session']);
  assert.deepEqual((await eligibleSignals(root)).map(row => row.key), ['same-problem']);
  assert.equal(starts.length, 2);
  assert.equal((await recordSignal(root, observation('same-problem', { source: 'agent' }), { launch })).duplicate, true);
});

test('R2: never-read outcomes and inventory exclude documents outside successful-read coverage', async t => {
  const root = fixture(t), home = fixture(t), memory = fixture(t);
  const skill = '.agents/skills/example/SKILL.md', suffix = '.agents/skills/example/NOTSKILL.md', page = resolve(memory, 'buckets/preferences/page.md');
  put(root, '.geppetto/config.json', { memory: { localPath: memory } });
  for (const path of ['docs/lesson.md', skill, suffix, page]) put(root, path, '# Synthetic owner');
  put(root, '.geppetto/signals.jsonl', rows([{ key: 'lesson', status: 'resolved', reference: 'synthetic', ts: '2026-10-01T00:00:00Z', paths: ['docs/lesson.md', skill, page] }]));
  await logReads(readEvent(root, 'docs/lesson.md'), { home });
  let report = await learningAudit(root, { home });
  assert.deepEqual(report.outcomes[0].neverRead, [skill, page]);
  assert.equal(report.outcomes[0].candidateToRevert, true);
  assert.equal(report.neverRead.includes(resolve(root, suffix)), false);
  for (const path of [skill, page]) await logReads(readEvent(root, path), { home });
  report = await learningAudit(root, { home });
  assert.deepEqual(report.outcomes[0].neverRead, []); assert.equal(report.outcomes[0].candidateToRevert, false);
  assert.equal((await localRecords(root, 'reads')).some(row => row.path === resolve(root, 'docs/lesson.md')), false);
  const privateRoot = resolve(memory, 'buckets/private');
  put(root, '.geppetto/config.json', { memory: { localPath: privateRoot } }); put(privateRoot, 'index.md', '# Synthetic private index');
  await logReads(readEvent(root, resolve(privateRoot, 'index.md')), { home });
  assert.equal((await localRecords(root, 'reads')).length, 3);
  assert.equal((await learningAudit(root, { home })).neverRead.includes(resolve(privateRoot, 'index.md')), false);
});

test('R3: learner working-copy reads count for source skills and memory pages while retaining the read revision', async t => {
  const root = fixture(t), home = fixture(t), skill = 'skills/example/SKILL.md', page = 'buckets/preferences/page.md';
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) assert.equal(git(root, args).status, 0);
  for (const path of [skill, page]) put(root, path, '# Original owner');
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'Synthetic baseline']);
  put(root, '.geppetto/config.json', { memory: { localPath: root } });
  put(root, '.geppetto/signals.jsonl', rows([{ ...observation('lesson'), id: 'eligible', source: 'user', status: 'open', ts: '2026-10-01T00:00:00Z' }]));
  const learned = await runLearning(root, { home, execute: async ({ cwd }) => {
    for (const path of [skill, page]) await learningFileTool(cwd, 'Write', { path, content: '# Improved owner' });
    return { decision: 'applied', owner: skill, reason: 'Synthetic correction at the existing owners.' };
  } });
  assert.equal(learned.status, 'committed');
  assert.equal((await learningAudit(root, { home })).outcomes[0].candidateToRevert, true);
  for (const path of [skill, page]) {
    assert.equal(await learningFileTool(learned.path, 'Read', { path }, false, null, { root, home, session: 'after-change' }), '# Improved owner');
    assert.equal(get(root, path), '# Original owner');
  }
  const report = await learningAudit(root, { home }), reads = await localRecords(root, 'reads');
  assert.deepEqual(report.outcomes[0].neverRead, []); assert.equal(report.outcomes[0].candidateToRevert, false);
  assert.equal(report.neverRead.includes(resolve(root, page)), false);
  assert.deepEqual(reads.map(row => row.path), [resolve(root, skill), resolve(root, page)]);
  assert.deepEqual(reads.map(row => row.readPath), [resolve(learned.path, skill), resolve(learned.path, page)]);
  assert.ok(reads.every(row => row.reference === report.outcomes[0].reference));
  const references = fixture(t), guide = resolve(references, 'example/SKILL.md');
  put(root, guide, '# External guide');
  assert.equal(await learningFileTool(learned.path, 'Read', { path: guide }, false, references, { root, home }), '# External guide');
  const external = (await localRecords(root, 'reads')).at(-1);
  assert.equal(external.path, guide); assert.equal(external.readPath, undefined); assert.equal(external.reference, undefined);
});

test('R4: equivalent timestamp instants select identical reads, outcomes, sessions and turns', async t => {
  const root = fixture(t), home = fixture(t), memory = fixture(t), page = resolve(memory, 'buckets/preferences/page.md');
  put(root, '.geppetto/config.json', { memory: { localPath: memory } }); put(root, page, '# Synthetic page');
  put(root, '.geppetto/signals.jsonl', rows([
    { ...observation('lesson'), id: 'one', source: 'agent', status: 'open', ts: '2026-10-02T00:10:00Z' },
    { key: 'lesson', status: 'resolved', reference: 'synthetic', paths: [page], ts: '2026-10-02T02:15:00+02:00' }
  ]));
  put(root, '.geppetto/reads.jsonl', rows([{ path: page, kind: 'memory', session: 'reads', ts: '2026-10-02T00:30:00Z' }]));
  put(root, '.geppetto/turns.jsonl', rows([{ sessionId: 'session', turnId: 'turn', feedback: { applies: true }, frustration: { applies: false }, ts: '2026-10-02T00:30:00Z' }]));
  const utc = await learningAudit(root, { home, since: '2026-10-02T00:00:00Z' });
  const offset = await learningAudit(root, { home, since: '2026-10-02T02:00:00+02:00' });
  assert.deepEqual(utc.neverRead, []); assert.deepEqual(utc.outcomes[0].neverRead, []);
  assert.equal(utc.outcomes.length, 1); assert.equal(utc.categories.find(row => row.id === 'workflow').sessions, 1);
  assert.deepEqual(utc.userFriction, { flagged: 1, turns: 1, unclassified: 0 });
  assert.deepEqual({ ...offset, since: null }, { ...utc, since: null });
  await assert.rejects(learningAudit(root, { home, since: 'invalid' }), /ISO date/);
});

test('R5: config and category proposals require nonempty string IDs and reject duplicates', async t => {
  const root = fixture(t), category = { id: 'configured', definition: 'Synthetic class.', score: 'Count confirmed episodes.' };
  for (const id of [undefined, null, '', ' ', 1, {}, ['configured']]) {
    const malformed = { ...category, id };
    assert.throws(() => validateConfig({ ...config(), categories: [malformed] }, 'synthetic-config.json'), /categories/);
  }
  assert.throws(() => validateConfig({ ...config(), categories: [category, category] }, 'synthetic-config.json'), /unique/);
  assert.equal(validateConfig({ ...config(), categories: [category] }, 'synthetic-config.json').categories[0].id, 'configured');
  for (const [key, session] of [['one', 'first'], ['two', 'second'], ['three', 'second']]) await recordSignal(root, observation(key, { session, category: 'other', evidence: 'synthetic.log:1' }), { launch: async () => {} });
  for (const id of [undefined, ['configured'], 'workflow']) await assert.rejects(maintainEvidence(root, { action: 'category', keys: ['one', 'two', 'three'], category: { ...category, id }, reason: 'Synthetic shared cause.' }), /categories/);
  assert.deepEqual(await localRecords(root, 'category-proposals'), []);
  await maintainEvidence(root, { action: 'category', keys: ['one', 'two', 'three'], category, reason: 'Synthetic shared cause.' });
  assert.equal((await localRecords(root, 'category-proposals'))[0].category.id, category.id);
});
