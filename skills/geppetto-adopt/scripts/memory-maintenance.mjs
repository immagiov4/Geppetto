import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { contained, rejectSymlinks, run } from './common.mjs';
import { memorySettings } from './memory-config.mjs';
import { MemoryRemoteError, verifiedMemoryRemote } from './memory-setup.mjs';
import { LearningContractError } from './learn-runner.mjs';
import { memoryPathKey, memoryScope } from './learner-tools.mjs';
import { withLocalLock } from './local-lock.mjs';
import { iso, machinePath, maintenanceCadence, memoryJobId, newCheck, notice, recordLockRecovery, updateHealth } from './health.mjs';
import { dirtyPaths, git, protectedBy, scanMemory, splitPaths, trackedTree, verifyEdits } from './memory-scan.mjs';
import { makeBatch, parseProposal, parseReview, reviewInput } from './memory-ops.mjs';
import { codexMemoryRunner, LearningAuthError } from './memory-runner.mjs';
import { registerMemoryRun, removeMemoryRun } from './memory-run-resources.mjs';

const shaPattern = /^(?:[a-f\d]{40}|[a-f\d]{64})$/;
function revisionWindows(cwd, head, prior, selected) {
  const buckets = git(cwd, ['ls-tree', '-d', '-r', '--name-only', '-z', head, '--', 'buckets'], { trim: false })
    .split('\0').filter(path => /^buckets\/[^/]+$/.test(path));
  const scopeNames = [...new Set(['.', ...buckets, ...Object.keys(prior).filter(path => /^buckets\/[^/]+$/.test(path))])].sort().filter(scope => memoryScope(scope, selected));
  const lastRunSha = { ...prior };
  const windows = Object.fromEntries(scopeNames.map(scope => {
    const since = prior[scope];
    if (!shaPattern.test(since) || run('git', ['merge-base', '--is-ancestor', since, head], { cwd }).status !== 0) {
      if (!shaPattern.test(since) || run('git', ['merge-base', '--is-ancestor', head, since], { cwd }).status !== 0) lastRunSha[scope] = head;
      return [scope, { mode: 'snapshot', head }];
    }
    lastRunSha[scope] = head;
    const pathSpec = scope === '.' ? ['.', ':(top,exclude)buckets'] : [':(top,literal)' + scope];
    const changed = git(cwd, ['diff', '--name-only', '--no-renames', '-z', since, head, '--', ...pathSpec], { trim: false })
      .split('\0').filter(Boolean);
    return [scope, { mode: 'incremental', since, head, changed }];
  }));
  return { windows, lastRunSha };
}

const currentBranch = cwd => run('git', ['symbolic-ref', '-q', 'HEAD'], { cwd }).stdout?.trim();
const currentHead = cwd => git(cwd, ['rev-parse', 'HEAD']);
const sameBase = (cwd, head, branch) => currentHead(cwd) === head && currentBranch(cwd) === branch;
const hasDirtyPath = (cwd, paths, execute) => {
  const dirty = dirtyPaths(cwd, execute);
  return paths.some(path => protectedBy(path, dirty));
};

async function fastForward({ cwd, args, head, branch, candidate }) {
  const transaction = spawn('git', [...args, 'update-ref', '-m', 'Consolidate memory', '--stdin'], {
    cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const closed = new Promise(resolve => transaction.once('close', resolve));
  transaction.on('error', () => {});
  transaction.stdin.on('error', () => {});
  const replies = createInterface({ input: transaction.stdout })[Symbol.asyncIterator]();
  try {
    // Preparing an update through HEAD locks the symbolic ref and checks its target's old SHA.
    transaction.stdin.write('start\nupdate HEAD ' + candidate + ' ' + head + '\nprepare\n');
    if ((await replies.next()).value !== 'start: ok' || (await replies.next()).value !== 'prepare: ok') return false;
    if (currentBranch(cwd) !== branch) return false;
    const checkout = run('git', [...args, 'read-tree', '-m', '-u', head, candidate], { cwd });
    if (checkout.status !== 0) return false;
    transaction.stdin.end('commit\n');
    if (await closed !== 0) throw new Error('Could not commit the prepared memory ref update.');
    return true;
  } finally {
    if (!transaction.stdin.writableEnded) transaction.stdin.end('abort\n');
    await closed;
  }
}

async function integrate({ cwd, head, branch, temporary, edits, log, execute }) {
  const isolated = resolve(temporary, 'checkout'), hooks = resolve(temporary, 'no-hooks');
  const args = ['-c', 'core.hooksPath=' + hooks, '-c', 'commit.gpgSign=false'];
  const gitLocal = (root, subcommand, options = {}) => git(root, [...args, ...subcommand], options);
  const paths = [...edits.keys()].sort();
  gitLocal(cwd, ['worktree', 'add', '--detach', isolated, head]);
  for (const path of paths) {
    const destination = resolve(isolated, path);
    if (!contained(isolated, destination)) throw new Error('Candidate path escapes the worktree.');
    await rejectSymlinks(destination);
    await writeFile(destination, edits.get(path));
  }
  gitLocal(isolated, ['--literal-pathspecs', 'add', '--', ...paths]);
  const staged = splitPaths(gitLocal(isolated, ['diff', '--cached', '--name-only', '-z', head], { trim: false })).sort();
  if (JSON.stringify(staged) !== JSON.stringify(paths)) throw new Error('Candidate staged paths differ from the approved edits.');
  for (const path of staged) {
    const stored = gitLocal(isolated, ['show', ':' + path], { trim: false });
    if (stored.replace(/\r\n/g, '\n') !== edits.get(path).replace(/\r\n/g, '\n')) throw new Error('Git altered an approved edit.');
  }
  gitLocal(isolated, ['-c', 'user.name=Geppetto', '-c', 'user.email=geppetto@localhost',
    'commit', '-m', 'Consolidate memory', '-m', 'Apply verified maintenance changes in one local commit.\n\nMemory-Event: refactor']);
  const candidate = currentHead(isolated);
  if (gitLocal(isolated, ['rev-parse', candidate + '^']) !== head) throw new Error('Candidate parent differs from the scanned base.');
  await log({ phase: 'integration', candidate });
  if (!branch || !sameBase(cwd, head, branch) || hasDirtyPath(cwd, paths, execute)) return null;
  if (!await fastForward({ cwd, args, head, branch, candidate })) return null;
  return candidate;
}

function verifiedSubset(scan, mechanical, approved) {
  const all = new Map([...mechanical, ...approved]);
  if (verifyEdits(scan, all)) return { edits: all, excluded: [] };
  // At most six semantic items share a batch. Keep the largest valid subset when
  // an approved edit depended on a different edit that the reviewer rejected.
  let best = null;
  for (let mask = 0; mask < (1 << approved.length); mask++) {
    const selected = approved.filter((_, index) => mask & (1 << index));
    if (best && selected.length <= best.length) continue;
    if (verifyEdits(scan, new Map([...mechanical, ...selected]))) best = selected;
  }
  if (!best) return null;
  const edits = new Map([...mechanical, ...best]);
  return { edits, excluded: approved.map(([path]) => path).filter(path => !edits.has(path)) };
}

async function runInCheckout({ home, cwd, settings, runId, prior, template, started, buckets, cadence, runner, usage, details, log, execute }) {
  if (!cwd || contained(cwd, machinePath(home, '.'))) throw new LearningContractError('Configure a dedicated machine memory checkout.');
  cwd = await realpath(cwd);
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  if (await realpath(root) !== cwd || contained(cwd, machinePath(home, '.'))) throw new LearningContractError('Configure the root of a dedicated machine memory checkout.');
  const remote = verifiedMemoryRemote(settings ?? {}, args => git(cwd, args));
  const origin = remote ? git(cwd, ['config', '--get', 'remote.' + remote + '.url']) : '';
  const repo = createHash('sha256').update(cwd + '\0' + origin).digest('hex');
  const head = currentHead(cwd), branch = currentBranch(cwd);
  const { windows, lastRunSha } = revisionWindows(cwd, head, prior.cursors?.[repo] ?? {}, buckets);
  const previous = prior.consolidation?.[repo] ?? {};
  const scan = scanMemory({ cwd, head, windows, dirty: dirtyPaths(cwd), selected: buckets, prior: previous, started, cadence });
  const batch = makeBatch(scan, template);
  let edits = new Map(scan.mechanics);
  const seen = { ...previous.seen }, findings = { ...previous.findings };
  const conflicts = Object.fromEntries(Object.entries(previous.conflicts ?? {}).filter(([path, oid]) =>
    memoryScope(path, buckets) && scan.tree.get(path)?.oid === oid));
  Object.assign(details, { base: head, scanned: scan.texts.size, planned: batch.byId.size, mechanical: edits.size });
  await log({ phase: 'scan', ...details });
  if (scan.rootIssue) return { outcome: 'incomplete', reason: 'The root memory index needs a correction outside the authorized semantic scope.' };
  if (scan.group.length && !batch.byId.size) return { outcome: 'incomplete', reason: batch.protectedItems ?
    'A memory item contains credential-like text and was withheld from the model.' : 'A memory item exceeds the proposal input budget.' };
  if (!verifyEdits(scan, edits)) return { outcome: 'incomplete', reason: 'The proposed mechanical repairs did not pass verification.' };
  const temporary = batch.byId.size || edits.size ? await registerMemoryRun(home, runId, cwd) : null;
  try {
    if (batch.byId.size) {
      const adapter = runner ?? codexMemoryRunner(home, temporary);
      const ask = async (phase, stdin) => {
        await log({ phase, inputBytes: Buffer.byteLength(stdin) });
        usage.calls++;
        try {
          const result = await adapter(phase, stdin);
          if (usage.tokens !== null) usage.tokens = Number.isSafeInteger(result?.tokens) && result.tokens >= 0 ? usage.tokens + result.tokens : null;
          return typeof result === 'string' ? result : result?.stdout;
        } catch (error) {
          usage.tokens = null;
          throw error;
        }
      };
      const proposed = parseProposal(await ask('proposer', batch.stdin), batch);
      if (!proposed) return { outcome: 'incomplete', reason: 'The memory proposer omitted, refused or returned an invalid item.' };
      for (const { path, review } of proposed) review.newText = scan.completeIndexRepair(path, review.newText);
      const proposal = new Map([...edits, ...proposed.map(({ path, review }) => [path, review.newText])]);
      if (!verifyEdits(scan, proposal)) return { outcome: 'incomplete', reason: 'The memory proposal failed link or index verification.' };
      if (proposed.length) {
        const stdin = reviewInput(proposed);
        if (stdin === null) return { outcome: 'incomplete', reason: 'The proposal exceeds the independent review budget.' };
        const verdicts = parseReview(await ask('reviewer', stdin), proposed);
        if (!verdicts) return { outcome: 'incomplete', reason: 'The independent reviewer omitted or returned an invalid verdict.' };
        details.verdicts = [...verdicts].map(([id, verdict]) => ({ id, verdict }));
        const approved = [];
        for (const { path, review } of proposed) {
          const verdict = verdicts.get(review.id);
          if (verdict === 'approve') approved.push([path, review.newText]);
          else {
            edits.delete(path);
            if (verdict === 'needs_human') conflicts[path] = scan.tree.get(path).oid;
          }
        }
        const subset = verifiedSubset(scan, edits, approved);
        if (!subset) return { outcome: 'incomplete', reason: 'The approved subset did not pass link or index verification.' };
        edits = subset.edits;
        const excluded = new Set(subset.excluded);
        for (const { path, review } of proposed) if (excluded.has(path)) {
          details.verdicts.find(row => row.id === review.id).applied = false;
        }
      }
      for (const { item } of batch.byId.values()) {
        scan.pending.delete(item.path);
        seen[item.path] = scan.tree.get(item.path).oid;
        if (scan.findingSignatures.has(item.path)) findings[item.path] = scan.findingSignatures.get(item.path);
        else delete findings[item.path];
      }
    }
    if (!verifyEdits(scan, edits)) return { outcome: 'incomplete', reason: 'The approved subset did not pass link or index verification.' };
    if (!sameBase(cwd, head, branch)) return { outcome: 'retry', reason: 'The memory checkout changed during maintenance.' };
    const integrated = edits.size ? await integrate({ cwd, head, branch, temporary, edits, log, execute }) : head;
    if (!integrated) return { outcome: 'retry', reason: 'The memory checkout changed or Git could not fast-forward safely.' };
    for (const scope of Object.keys(windows)) if (lastRunSha[scope] === head) lastRunSha[scope] = integrated;
    const finalTree = integrated === head ? scan.tree : trackedTree(cwd, integrated);
    for (const path of edits.keys()) {
      seen[path] = finalTree.get(path).oid;
      if (conflicts[path]) conflicts[path] = seen[path];
    }
    for (const path of Object.keys(seen)) if (!finalTree.has(path) || !memoryScope(path, buckets)) delete seen[path];
    const rotation = scan.rotated
      ? scan.pending.has(scan.rotated) ? scan.rotation : { at: started, after: scan.rotated }
      : scan.rotation;
    for (const path of Object.keys(findings)) if (!Object.hasOwn(seen, path) || edits.has(path)) delete findings[path];
    const consolidation = { pending: [...scan.pending].sort(), seen, findings, conflicts, rotation };
    Object.assign(details, { revision: integrated, commit: edits.size ? integrated : null, deferred: scan.pending.size, conflicts: Object.keys(conflicts).length });
    return {
      outcome: details.conflicts ? 'needs_human' : edits.size ? 'done' : usage.calls ? 'reviewed' : 'no_change',
      repo, lastRunSha, consolidation, verified: true,
    };
  } finally {
    if (temporary) await removeMemoryRun(temporary, cwd);
  }
}

export async function maintainMemory({ home, cwd, job, template, runner, now = Date.now, execute = run }) {
  const lock = machinePath(home, 'maintain-memory.lock');
  await rejectSymlinks(lock);
  const exit = await withLocalLock(lock, async () => {
    const started = now(), runId = randomUUID(), cadence = maintenanceCadence(job.cadence);
    const prior = await updateHealth(home, checks => {
      const previous = checks[memoryJobId] ?? newCheck();
      checks[memoryJobId] = { ...previous, cadenceMs: cadence, monitoredSince: previous.monitoredSince ?? iso(started), lastRun: iso(started), runId, phase: 'running' };
      return previous;
    }, started);
    const usage = { calls: 0, tokens: 0 }, details = {};
    const journal = machinePath(home, 'maintain-memory.log');
    const log = async row => {
      await rejectSymlinks(journal);
      await appendFile(journal, JSON.stringify({ runId, ...row }) + '\n', { mode: 0o600 });
    };
    let result;
    try {
      const settings = await memorySettings(home, home);
      const buckets = (settings?.buckets ?? []).map(memoryPathKey);
      result = await runInCheckout({ home, cwd: cwd ?? settings?.localPath, settings, runId, prior, template, started, cadence, buckets, runner, usage, details, log, execute });
    } catch (error) {
      const identified = error instanceof LearningAuthError || error instanceof LearningContractError || error instanceof MemoryRemoteError;
      const blocked = identified || ['EACCES', 'EPERM', 'ENOENT'].includes(error.code ?? error.cause?.code);
      result = { outcome: blocked ? 'refused' : 'error', reason: identified ? error.message : blocked ? 'Check access to the configured memory checkout.' : 'The memory maintenance operation failed. Check the Git checkout and runner.' };
    }
    const { outcome, repo, lastRunSha, consolidation, verified = false } = result, finished = now();
    const reason = result.reason ?? (outcome === 'needs_human' ? 'A memory consolidation conflict requires a decision. See the maintain-memory run log.' : null);
    const receipt = { runId, outcome, verified, usage, durationMs: Math.max(0, finished - started), ...details };
    try { await log({ ...receipt, phase: 'receipt', reason }); }
    finally {
      await updateHealth(home, checks => {
        const check = checks[memoryJobId];
        const state = outcome === 'needs_human' || outcome === 'refused' ? 'blocked' : verified ? 'ok' : 'degraded';
        const summary = reason ?? 'maintain-memory has no verified completion receipt.';
        const newNotice = state === 'ok' ? null : check.fingerprint === outcome && check.pendingNotice?.summary === summary ? check.pendingNotice : notice(state === 'blocked' ? 'blocker' : 'repair', summary, finished);
        Object.assign(check, { state, phase: null, outcome, receipt, fails: state === 'ok' ? 0 : prior.fails + 1,
          fingerprint: state === 'ok' ? null : outcome, escalation: state === 'blocked' ? summary : null, pendingNotice: newNotice });
        if (verified) Object.assign(check, { lastOk: iso(finished), lastRunSha, cursors: { ...prior.cursors, [repo]: lastRunSha },
          consolidation: { ...prior.consolidation, [repo]: consolidation } });
      }, finished);
    }
    return verified && outcome !== 'needs_human' ? 0 : 1;
  }, { onRecovery: healed => recordLockRecovery(home, 'lock:maintenance', 'an abandoned maintenance lock', now(), healed) });
  return exit ?? 1;
}
