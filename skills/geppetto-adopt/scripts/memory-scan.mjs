import { posix } from 'node:path';
import { gitOutput } from './common.mjs';
import { memoryDigest, memoryMarkdown, memoryPathKey, memoryScope } from './learner-tools.mjs';

export const git = (cwd, args, options = {}) => gitOutput(cwd, args, { detail: false, ...options });
export const splitPaths = output => output.split('\0').filter(Boolean);
export const scopeOf = path => /^buckets\/[^/]+/.exec(path)?.[0] ?? '.';
export const isIndex = path => /(?:^|\/)index\.md$/i.test(path);
const claudePath = path => /^buckets\/[^/]+\/claude(?:\/|$)/i.test(path);
const regularFile = mode => /^100(?:644|755)$/.test(mode);
const key = memoryPathKey;
export const overlaps = (left, right) => left === right || left.startsWith(right + '/') || right.startsWith(left + '/');
export const protectedBy = (path, dirty) => [...dirty].some(name => overlaps(key(path), key(name)));
const canEdit = (path, selected, dirty) => memoryScope(path, selected) && !claudePath(path) && !protectedBy(path, dirty);
const markdown = (path, entry) => (path === 'index.md' || scopeOf(path) !== '.') && regularFile(entry.mode) && memoryMarkdown(path);
const MAX_PAGE_BYTES = 32 * 1024;

export function trackedTree(cwd, head) {
  return new Map(splitPaths(git(cwd, ['ls-tree', '-r', '-z', head], { trim: false })).map(row => {
    const tab = row.indexOf('\t');
    const [mode, , oid] = row.slice(0, tab).split(' ');
    return [row.slice(tab + 1), { mode, oid }];
  }));
}

export function dirtyPaths(cwd, execute) {
  const status = splitPaths(git(cwd, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], { trim: false, execute }));
  const hidden = splitPaths(git(cwd, ['ls-files', '-v', '-z'], { trim: false, execute })).filter(row => /^[a-zS] /.test(row));
  return new Set([...status.map(row => row.slice(3)), ...hidden.map(row => row.slice(2))]);
}

function blobs(cwd, entries) {
  const ids = [...new Set(entries.map(([, { oid }]) => oid))];
  if (!ids.length) return new Map();
  const sizes = git(cwd, ['cat-file', '--batch-check=%(objectname) %(objectsize)'], { input: ids.join('\n') + '\n' }).split('\n');
  const small = sizes.map(row => row.split(' ')).filter(([, size]) => /^\d+$/.test(size) && Number(size) <= MAX_PAGE_BYTES).map(([oid]) => oid);
  if (!small.length) return new Map();
  const buffer = git(cwd, ['cat-file', '--batch'], { input: Buffer.from(small.join('\n') + '\n'), encoding: null, trim: false });
  const byId = new Map();
  for (let offset = 0; offset < buffer.length;) {
    const end = buffer.indexOf(10, offset);
    if (end < 0) throw new Error('Invalid Git blob header.');
    const [oid, type, length] = buffer.toString('ascii', offset, end).split(' ');
    const next = end + 1 + Number(length);
    if (type !== 'blob' || buffer[next] !== 10) throw new Error('Invalid Git blob.');
    byId.set(oid, buffer.toString('utf8', end + 1, next));
    offset = next + 1;
  }
  return new Map(entries.filter(([, { oid }]) => byId.has(oid)).map(([path, { oid }]) => [path, byId.get(oid)]));
}

function proseLineFilter() {
  let fence;
  return line => {
    const match = /^ {0,3}(\x60{3,}|~{3,})([^\r\n]*)/.exec(line);
    const [, marker, suffix] = match ?? [];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length && /^[ \t]*$/.test(suffix)) fence = null;
      return false;
    }
    if (marker && (marker[0] === '~' || !suffix.includes('\x60'))) {
      fence = marker;
      return false;
    }
    return true;
  };
}
function proseLines(text) {
  return text.split(/\r?\n/).filter(proseLineFilter()).map(line => line.replace(/\x60[^\x60]+\x60/g, ''));
}
function links(text) {
  return proseLines(text).flatMap(line => [
    ...[...line.matchAll(/(?<!!)\[[^\]\n]+\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^)]*["'])?\s*\)/g)].map(match => match[1]),
    ...[...line.matchAll(/^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/g)].map(match => match[1]),
  ]);
}
function localTarget(path, raw) {
  const address = raw.replace(/^<|>$/g, '');
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(address) || address.startsWith('#')) return null;
  try {
    const target = decodeURIComponent(address.split(/[?#]/)[0]);
    return target.startsWith('/') ? posix.normalize(target.slice(1)) : posix.normalize(posix.join(posix.dirname(path), target));
  } catch { return ''; }
}
function lookupFor(tree) {
  const names = new Map([...tree.keys()].map(path => [key(path), path]));
  for (const path of tree.keys()) {
    for (let parent = posix.dirname(path); parent !== '.'; parent = posix.dirname(parent)) {
      names.set(key(parent), names.get(key(parent + '/index.md')) ?? parent);
    }
  }
  return name => names.get(key(name?.replace(/\/$/, '') ?? ''));
}
const tombstone = /^\s*(?:[-*+]|>|\|)?\s*(?:\*\*)?Superseded \d{4}-\d{2}-\d{2} by\b/i;
const provenanceLine = /^\s*(?:[-*+]\s+|#{1,6}\s+)?(?:\*\*)?(?:sources?|provenance|evidence|font[ei])\b(?:\*\*)?\s*(?::|$)/i;
const inlineProvenance = /\[source: .+; added: \d{4}-\d{2}-\d{2}(?:; verified: \d{4}-\d{2}-\d{2})?\]\s*$/i;
const externalReferences = /(?:https?:\/\/|[a-z][a-z0-9+.-]*:\/\/)[^\s<>)\]"']+/gi;
export const sources = text => [...new Set([
  ...proseLines(text).filter(line => provenanceLine.test(line) || inlineProvenance.test(line)),
  ...proseLines(text).flatMap(line => line.match(externalReferences) ?? []),
])];
const isSuperseded = text => proseLines(text).some(line => tombstone.test(line) && links(line).length);
const exactRow = line => /^\s*(?:\|.+\||[-*+]\s+\[.+\]\(.+\))\s*$/.test(line) && !/^\s*\|[\s|:-]+\|\s*$/.test(line);

function mechanicalEdit(path, oldText, lookup, renames, selected) {
  const seen = new Set();
  const edits = new Map();
  for (const link of links(oldText)) {
    const name = localTarget(path, link), moved = renames.get(name);
    if (name === null || lookup(name) || !moved || !memoryScope(moved, selected) || !lookup(moved)) continue;
    const suffix = /[?#].*/.exec(link.replace(/>$/, ''))?.[0] ?? '';
    const relative = posix.relative(posix.dirname(path), moved).split('/').map(encodeURIComponent).join('/');
    edits.set(link, relative + suffix);
  }
  const isProse = proseLineFilter();
  return oldText.split(/(?<=\n)/).flatMap(line => {
    if (!isProse(line)) return [line];
    if (isIndex(path) && exactRow(line) && links(line).every(link => memoryScope(localTarget(path, link) ?? '', selected))) {
      const row = line.replace(/\r?\n$/, '');
      if (seen.has(row)) return [];
      seen.add(row);
    }
    if (!edits.size) return [line];
    return [line.split(/(\x60[^\x60]+\x60)/).map((segment, index) => index % 2 ? segment : segment
      .replace(/(\]\(\s*)(<[^>]+>|[^\s)]+)(?=[\s)])/g, (match, prefix, link) => edits.has(link) ? prefix + edits.get(link) : match)
      .replace(/^(\s*\[[^\]]+\]:\s*)(<[^>]+>|\S+)/, (match, prefix, link) => edits.has(link) ? prefix + edits.get(link) : match)).join('')];
  }).join('');
}

function issueKeys(texts, lookup, unavailableIndexes) {
  const indexed = new Set();
  const issues = new Map();
  for (const [path, content] of texts) {
    const result = new Set();
    const seen = new Set();
    for (const line of proseLines(content)) {
      if (!isIndex(path)) continue;
      if (tombstone.test(line)) result.add('index_tombstone');
      if (exactRow(line) && seen.has(line)) result.add('duplicate_index_row:' + memoryDigest(line));
      seen.add(line);
    }
    for (const link of links(content)) {
      const target = localTarget(path, link);
      if (target === null) continue;
      const found = lookup(target);
      if (!found) result.add('broken_link:' + link);
      else if (isIndex(path)) indexed.add(found);
    }
    issues.set(path, result);
  }
  for (const [path, content] of texts) {
    if (path === 'index.md' || claudePath(path) || indexed.has(path) || unavailableIndexes.has(scopeOf(path)) || (!isIndex(path) && isSuperseded(content))) continue;
    if (scopeOf(path) !== '.') issues.get(path).add('unindexed');
  }
  return issues;
}

function renamesInWindows(cwd, windows) {
  const result = new Map();
  const seen = new Set();
  for (const { since, head } of Object.values(windows)) {
    if (!since || head === since || seen.has(since)) continue;
    seen.add(since);
    const rows = splitPaths(git(cwd, ['diff', '--name-status', '-z', '--find-renames=100%', since, head], { trim: false }));
    for (let i = 0; i < rows.length;) {
      const status = rows[i++], from = rows[i++];
      if (status !== 'R100') continue;
      const to = rows[i++];
      if (!result.has(from)) result.set(from, to);
      else if (result.get(from) !== to) result.set(from, null);
    }
  }
  return result;
}

export function scanMemory({ cwd, head, windows, dirty, selected, prior, started, cadence }) {
  const tree = trackedTree(cwd, head);
  const lookup = lookupFor(tree);
  const entries = [...tree].filter(([path, entry]) => memoryScope(path, selected) && markdown(path, entry));
  const readable = entries.filter(([path]) => !claudePath(path) && !protectedBy(path, dirty));
  const texts = blobs(cwd, readable);
  const renames = renamesInWindows(cwd, windows);
  const mechanics = new Map();
  for (const [path, oldText] of texts) {
    const content = mechanicalEdit(path, oldText, lookup, renames, selected);
    if (content !== oldText) mechanics.set(path, content);
  }
  const unavailableIndexes = new Set(entries.filter(([path]) => isIndex(path) && !claudePath(path) && !texts.has(path)).map(([path]) => scopeOf(path)));
  const baseIssues = issueKeys(texts, lookup, unavailableIndexes);
  const projected = new Map([...texts, ...mechanics]);
  let issues = issueKeys(projected, lookup, unavailableIndexes);
  const deferredIndexes = new Set();
  for (const path of mechanics.keys()) {
    if (!isIndex(path) || ![...issues.get(path)].some(issue => issue !== 'unindexed')) continue;
    deferredIndexes.add(path);
    mechanics.delete(path);
    projected.set(path, texts.get(path));
  }
  if (deferredIndexes.size) issues = issueKeys(projected, lookup, unavailableIndexes);
  const candidates = new Map(), pending = new Set();
  const previous = prior.seen ?? {}, previousFindings = prior.findings ?? {};
  const findingSignatures = new Map(), related = new Map();
  const movedPaths = new Set(renames.values());
  const changed = new Set(Object.values(windows).flatMap(window => window.changed ?? []));
  const conflict = path => prior.conflicts?.[path] === tree.get(path)?.oid && Boolean(tree.get(path));
  const active = path => windows[scopeOf(path)]?.mode === 'snapshot' || changed.has(path) || (prior.pending ?? []).includes(path);
  const mark = (path, reason) => {
    if (!candidates.has(path)) candidates.set(path, new Set());
    candidates.get(path).add(reason);
  };
  const peers = entries.filter(([path]) => claudePath(path) && !protectedBy(path, dirty));
  const peerMatches = new Set(peers.map(([path, entry]) => scopeOf(path) + '\0' + entry.oid));
  const peerPaths = new Map(peers);
  for (const [path, entry] of entries) {
    if (claudePath(path)) continue;
    if (!canEdit(path, selected, dirty)) {
      if (active(path)) pending.add(path);
      continue;
    }
    if (path === 'index.md' || conflict(path)) continue;
    const content = projected.get(path);
    const findings = [...(issues.get(path) ?? [])].map(issue => issue.split(':')[0]);
    if (content && !isIndex(path) && !sources(content).length) findings.push('missing_provenance');
    if (content && sources(content).some(source => links(source).some(link => changed.has(lookup(localTarget(path, link)))))) findings.push('stale_provenance');
    const scope = scopeOf(path), peer = scope + '/claude/' + path.slice(scope.length + 1);
    const counterpart = peerPaths.get(peer);
    if (peerMatches.has(scope + '\0' + entry.oid)) findings.push('matches_read_only_claude');
    else if (counterpart && !isIndex(path)) {
      findings.push('differs_from_read_only_claude');
      related.set(path, [peer, counterpart]);
    }
    const signature = memoryDigest(JSON.stringify([entry.oid, ...(issues.get(path) ?? []), findings, counterpart?.oid]));
    if (findings.length) findingSignatures.set(path, signature);
    const activeChange = active(path) && (!movedPaths.has(path) || findings.length) &&
      (previous[path] !== entry.oid || (prior.pending ?? []).includes(path));
    if (!activeChange && (!findings.length || previousFindings[path] === signature)) continue;
    if (mechanics.has(path) && !findings.length) continue;
    if (activeChange) mark(path, 'changed');
    for (const finding of findings) mark(path, finding);
    if (findings.includes('unindexed') && !isIndex(path)) {
      const index = scopeOf(path) + '/index.md';
      if (texts.has(index) && !conflict(index)) mark(index, 'unindexed_page');
    }
  }
  let rotation = prior.rotation ?? { at: started, after: '' };
  let rotated;
  if (started - rotation.at >= cadence) {
    const old = git(cwd, ['rev-list', '-1', '--before=' + new Date(started - cadence).toISOString(), head]);
    const older = old ? trackedTree(cwd, old) : new Map();
    const eligible = [...projected.keys()].filter(path => !isIndex(path) && !conflict(path) && older.get(path)?.oid === tree.get(path)?.oid);
    rotated = eligible.find(path => path > rotation.after) ?? eligible[0];
    if (rotated) mark(rotated, 'rotation');
    else rotation = { ...rotation, at: started };
  }
  const groups = [...candidates.keys()].sort((a, b) => {
    const priority = path => [...candidates.get(path)].some(reason => reason !== 'changed' && reason !== 'rotation') ? 0 : 1;
    return priority(a) - priority(b) || (a < b ? -1 : a > b ? 1 : 0);
  });
  for (const path of groups) pending.add(path);
  const root = projected.get('index.md');
  const rootIssue = root && (proseLines(root).some(line => tombstone.test(line)) || links(root).some(link => {
    const name = localTarget('index.md', link);
    return name !== null && memoryScope(name, selected) && !lookup(name);
  }));
  return { tree, texts, projected, mechanics, baseIssues, lookup, pending, rotation, rotated, candidates, findingSignatures,
    rootIssue, unavailableIndexes, group: groups,
    completeIndexRepair(path, content) {
      return deferredIndexes.has(path) ? mechanicalEdit(path, content, lookup, renames, selected) : content;
    },
    counterpart(path) {
      const entry = related.get(path);
      return entry ? blobs(cwd, [entry]).get(entry[0]) : undefined;
    } };
}

export function verifyEdits(scan, edits) {
  const next = new Map([...scan.texts, ...edits]);
  for (const [path, newIssues] of issueKeys(next, scan.lookup, scan.unavailableIndexes)) {
    if ([...newIssues].some(issue => !scan.baseIssues.get(path)?.has(issue))) return false;
    if (edits.has(path) && isIndex(path) && [...newIssues].some(issue => issue !== 'unindexed')) return false;
  }
  return true;
}
