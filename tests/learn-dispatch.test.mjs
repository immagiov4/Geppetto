import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, put, get, invoke } from './helpers.mjs';
import { learningStep, learningStatus, ledgerAuthority } from '../skills/geppetto-adopt/scripts/learn-dispatch.mjs';

const policy = { enabled: true, provider: 'synthetic', assessmentMaxUsd: '0', investigationMaxUsd: '0', boundary: 'fixture-only', scope: 'project' };
function signals(root, more = []) {
  const records = [
    { id: 's1', ts: '2026-10-26T00:00:00Z', scope: 'project', kind: 'friction', metric: 'reliability', text: 'The invocation lost the working directory', episode: 'build-a', source: 'test:a' },
    { id: 's2', ts: '2026-10-26T01:00:00Z', scope: 'project', kind: 'error', metric: 'reliability', text: 'Relative inputs were resolved in home', episode: 'build-b', source: 'test:b' }, ...more,
  ];
  put(root, '.geppetto/signals.jsonl', records.map(r => JSON.stringify(r)).join('\n') + '\n');
  return records;
}
const judgment = (records, disposition = 'recurring') => ({ disposition, cause: 'Child working directory is not passed to the launcher', rationale: 'Separate builds expose the same invocation boundary, not matching phrases.', alternatives: 'A missing input file does not explain the different resolved directory.', cluster: null, comparisons: [], evidence: records.map(r => ({ signalId: r.id, episode: r.episode, source: r.source, support: 'The invocation and resolved path identify this episode.' })) });
function hostFor(records, extra = {}) {
  const calls = [];
  return { name: 'synthetic', calls, async submit(request, ack) { calls.push(request); await ack({ runId: `run-${calls.length}` }); return { ready: true, runId: `run-${calls.length}`, costUsd: '0', payload: request.phase === 'assessment' ? judgment(records) : { disposition: 'keep', owner: 'fixture/launcher', rationale: 'Measured improvement', evidence: ['test:baseline', 'test:treatment', 'test:verify'], limitations: ['synthetic only'] } }; }, ...extra };
}
const allow = async () => ({ decision: 'allow', reference: 'synthetic task grant' });

for (const overrun of [false, true]) test(`paid finalization ${overrun ? 'waits for overrun reconciliation' : 'does not reserve the settled cost again'}`, async t => {
  const root = fixture(t), home = fixture(t); const records = signals(root);
  const grants = `[signal-assessment] provider=synthetic budget_usd=0 per=1d scope="project" expires=never\n[signal-investigation] provider=synthetic budget_usd=${overrun ? 3 : 1} per=1d scope="project" expires=never\n`;
  for (const owner of [root, home]) put(owner, '.geppetto/authorizations', grants);
  let finalized = 0;
  const host = hostFor(records, {
    async submit(request, ack) {
      this.calls.push(request); const runId = `paid-${this.calls.length}`; await ack({ runId });
      return { ready: true, runId, costUsd: request.phase === 'assessment' ? '0' : overrun ? '1.5' : '1',
        payload: request.phase === 'assessment' ? judgment(records) : { disposition: 'keep', owner: 'docs/lesson.md', rationale: 'Verified correction', evidence: ['test:verified'], limitations: [] },
        ...(request.phase === 'investigation' ? { proposal: { status: 'pending-review', path: 'synthetic-worktree' } } : {}) };
    },
    async finalize(proposal) { finalized++; return { ...proposal, status: 'committed' }; },
  });
  const authorize = ledgerAuthority(root, (_executable, args) => invoke('authz.mjs', args.slice(1), { cwd: root, home }));
  await learningStep(root, { policy: { ...policy, billing: 'api', investigationMaxUsd: '1' }, host, authorize });
  const state = await learningStatus(root);
  assert.equal(finalized, overrun ? 0 : 1);
  assert.equal(state.status, overrun ? 'pending' : 'keep');
  if (overrun) assert.equal(state.attempts[1].proposal.status, 'pending-review');
});

test('recorder stays append-only and learning without an available authorized host remains inspectably pending', async t => {
  const root = fixture(t);
  const r = invoke('signal.mjs', ['wrong cwd', '--metric', 'reliability', '--episode', 'build-a', '--source', 'test:a'], { cwd: root });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(get(root, '.geppetto/signals.jsonl')).episode, 'build-a');
  const status = await learningStatus(root);
  assert.equal(status.status, 'pending'); assert.match(status.reason, /authorized available learning host/);
});

test('source-linked semantic assessment reaches actual ack and verified owner outcome once', async t => {
  const root = fixture(t); const records = signals(root); const host = hostFor(records);
  await learningStep(root, { policy, host, authorize: allow });
  const state = await learningStatus(root);
  assert.equal(host.calls.length, 2); assert.equal(state.assessments[0].judgment.disposition, 'recurring');
  assert.equal(state.attempts[1].status, 'completed'); assert.equal(state.attempts[1].runId, 'run-2');
  assert.equal(state.clusters[0].outcome.disposition, 'keep');
  await learningStep(root, { policy, host, authorize: allow }); assert.equal(host.calls.length, 2);
});

test('isolated, ambiguous and invented independent evidence cannot dispatch an investigation', async t => {
  for (const disposition of ['isolated', 'pending', 'forged']) {
    const root = fixture(t); const records = signals(root); const host = hostFor(records, { async submit(req, ack) { this.calls.push(req); await ack({ runId: 'assessment' }); const j = judgment(records, disposition === 'forged' ? 'recurring' : disposition); if (disposition === 'forged') j.evidence[1].episode = 'invented'; return { ready: true, runId: 'assessment', costUsd: '0', payload: j }; } });
    await learningStep(root, { policy, host, authorize: allow }); assert.equal(host.calls.length, 1);
    const state = await learningStatus(root); assert.equal(state.clusters.length, 0);
  }
});

test('unknown budgets, denied consent and unsupported hosts remain pending without a launch', async t => {
  for (const options of [{ policy: { ...policy, assessmentMaxUsd: null } }, { authorize: async () => ({ decision: 'deny', reference: 'revoked' }) }, { host: undefined }]) {
    const root = fixture(t); const records = signals(root); const host = hostFor(records);
    await learningStep(root, { policy, host, authorize: allow, ...options });
    const state = await learningStatus(root); assert.equal(state.status, 'pending'); assert.equal(host.calls.length, 0); assert.ok(state.reason);
  }
});

test('concurrent events cannot duplicate assessment or investigation claims', async t => {
  const root = fixture(t); const records = signals(root); const host = hostFor(records);
  await Promise.all(Array.from({ length: 8 }, () => learningStep(root, { policy, host, authorize: allow })));
  assert.equal(host.calls.length, 2); assert.equal((await learningStatus(root)).clusters.length, 1);
});

test('unknown dispatch acknowledgement is retained and never automatically retried', async t => {
  const root = fixture(t); const records = signals(root); let calls = 0;
  const host = hostFor(records, { async submit() { calls++; throw new Error('transport lost token=secret'); } });
  await learningStep(root, { policy, host, authorize: allow });
  await learningStep(root, { policy, host, authorize: allow });
  const state = await learningStatus(root); assert.equal(calls, 1); assert.equal(state.attempts[0].status, 'unknown'); assert.doesNotMatch(JSON.stringify(state), /token=secret/);
});

test('changed evidence receives a new semantic assessment; replayed episodes do not reopen a rejected cause', async t => {
  const root = fixture(t); let records = signals(root); let calls = 0;
  const host = hostFor(records, { async submit(req, ack) {
    calls++; await ack({ runId: `native-${calls}` });
    const prior = (await learningStatus(root)).clusters[0];
    const j = judgment(records); j.cluster = prior?.id ?? null; j.comparisons = prior ? [{ cluster: prior.id, relation: 'same', reason: 'The same invocation boundary is evidenced.' }] : [];
    return { ready: true, runId: `native-${calls}`, costUsd: '0', payload: req.phase === 'assessment' ? j : { disposition: 'reject', owner: 'fixture/launcher', rationale: 'Treatment did not improve reliability', evidence: ['test:comparison'], limitations: ['synthetic'] } };
  } });
  await learningStep(root, { policy, host, authorize: allow }); assert.equal(calls, 2);
  records = signals(root, [{ ...records[0], id: 'resubmission' }]);
  await learningStep(root, { policy, host, authorize: allow });
  const state = await learningStatus(root); assert.equal(calls, 3); assert.equal(state.assessments.length, 2); assert.equal(state.clusters.length, 1);
  assert.equal(state.status, 'reject');
});

test('asynchronous Hermes-shaped acknowledgements are polled, not relaunched, and keep source links', async t => {
  const root = fixture(t); const records = signals(root); const results = new Map(); let calls = 0;
  const host = hostFor(records, { async submit(req, ack) { const runId = `async-${++calls}`; await ack({ runId }); results.set(runId, { ready: true, runId, costUsd: '0', payload: req.phase === 'assessment' ? judgment(records) : { disposition: 'pending', owner: 'fixture/launcher', rationale: 'Needs owner decision', evidence: ['test:assessment'], limitations: ['No approved edit'] } }); return { ready: false, runId }; }, async poll(runId) { return results.get(runId); } });
  for (let i = 0; i < 4; i++) await learningStep(root, { policy, host, authorize: allow });
  const state = await learningStatus(root); assert.equal(calls, 2); assert.equal(state.clusters[0].outcome.disposition, 'pending'); assert.equal(state.assessments[0].signalIds.length, 2);
});

test('new independent evidence is assessed while one unresolved cause retains its sole investigation', async t => {
  const root = fixture(t); let records = signals(root); let calls = 0;
  const host = hostFor(records, { async submit(req, ack) {
    const runId = `inflight-${++calls}`; await ack({ runId });
    if (req.phase === 'investigation') return { ready: false, runId };
    const prior = (await learningStatus(root)).clusters[0];
    const j = judgment(records); j.cluster = prior?.id ?? null; j.comparisons = prior ? [{ cluster: prior.id, relation: 'same', reason: 'The new independent build reaches the same launcher boundary.' }] : [];
    return { ready: true, runId, costUsd: '0', payload: j };
  } });
  await learningStep(root, { policy, host, authorize: allow });
  records = signals(root, [{ id: 's3', ts: '2026-10-26T02:00:00Z', scope: 'project', kind: 'error', text: 'Third build resolves input outside its working folder', metric: 'reliability', episode: 'build-c', source: 'test:c' }]);
  await learningStep(root, { policy, host, authorize: allow });
  const state = await learningStatus(root); assert.equal(calls, 3); assert.equal(state.assessments.length, 2); assert.equal(state.attempts.filter(a => a.phase === 'investigation').length, 1); assert.equal(state.status, 'pending'); assert.match(state.reason, /unresolved/);
});

test('actual cost absent from a native result blocks investigation and does not invent zero', async t => {
  const root = fixture(t); const records = signals(root);
  const host = hostFor(records, { async submit(req, ack) { this.calls.push(req); await ack({ runId: 'cost-unknown' }); return { ready: true, runId: 'cost-unknown', payload: judgment(records) }; } });
  await learningStep(root, { policy, host, authorize: allow });
  const state = await learningStatus(root); assert.equal(host.calls.length, 1); assert.equal(state.status, 'pending'); assert.match(state.reason, /cost|spending/i);
});

test('known cost above the granted maximum settles truthfully and pauses further automatic work', async t => {
  const root = fixture(t); const records = signals(root); let calls = 0; const accounting = [];
  const host = hostFor(records, { async submit(req, ack) { calls++; await ack({ runId: 'overrun' }); return { ready: true, runId: 'overrun', costUsd: '0.000001', payload: judgment(records) }; } });
  await learningStep(root, { policy, host, authorize: async request => { accounting.push(request); return allow(); } });
  const state = await learningStatus(root); assert.equal(calls, 1); assert.equal(state.attempts[0].actualUsd, '0.000001'); assert.equal(state.attempts[0].budgetExceeded, true); assert.equal(state.status, 'pending'); assert.match(state.reason, /maximum/); assert.equal(accounting[1].actual, '0.000001');
});

test('revocation between assessment and investigation prevents the second launch', async t => {
  const root = fixture(t); const records = signals(root); const host = hostFor(records);
  const authorize = async request => request.capability === 'signal-investigation' ? { decision: 'deny', reference: 'Owner revoked unattended scope' } : allow();
  await learningStep(root, { policy, host, authorize }); assert.equal(host.calls.length, 1); assert.match((await learningStatus(root)).reason, /revoked/);
});

test('same episode twice, foreign scope, missing provenance and unsupported assessment claims stay pending', async t => {
  for (const mode of ['duplicate', 'scope', 'provenance']) {
    const root = fixture(t); const records = signals(root); if (mode === 'duplicate') records[1].episode = records[0].episode; if (mode === 'scope') records[1].scope = 'other'; if (mode === 'provenance') delete records[1].source;
    put(root, '.geppetto/signals.jsonl', records.map(r => JSON.stringify(r)).join('\n') + '\n');
    const host = hostFor(records); await learningStep(root, { policy: { ...policy, scope: undefined }, host, authorize: allow });
    assert.equal(host.calls.length, 1); assert.equal((await learningStatus(root)).status, 'pending');
  }
});
