import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { exists, contained } from './common.mjs';

const bucketName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Parse only the root Bucket | Scope | Holds table; descriptions remain data. */
export function bucketCatalog(text) {
  const buckets = []; let columns;
  for (const line of text.split(/\r?\n/)) {
    if (!/^\s*\|/.test(line)) { columns = null; continue; }
    const cells = line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(cell => cell.trim().replaceAll('\\|', '|'));
    if (['bucket', 'scope', 'holds'].every(name => cells.some(cell => cell.toLowerCase() === name))) { columns = cells.map(cell => cell.toLowerCase()); continue; }
    if (!columns || cells.every(cell => /^:?-+:?$/.test(cell))) continue;
    const raw = cells[columns.indexOf('bucket')] ?? '';
    const link = raw.match(/^\[([^\]]+)\]\(buckets\/([^/]+)\/index\.md\)$/);
    const name = link ? link[2] : raw.replace(/^`|`$/g, '');
    const scope = cells[columns.indexOf('scope')]; const description = cells[columns.indexOf('holds')];
    if (!bucketName.test(name) || !scope || !description || buckets.some(bucket => bucket.name === name)) throw new Error('Root memory index has an invalid or duplicate bucket row');
    buckets.push({ name, scope: scope.toLowerCase(), description });
  }
  if (!buckets.length) throw new Error('Root memory index needs a Bucket | Scope | Holds table');
  return buckets;
}

/** Resolve an indexed document inside its real bucket, including nested indexes. */
export async function memoryPath(memory, bucket, document = 'index.md') {
  if (bucket.toLowerCase() === 'private') throw new Error('The private bucket index is excluded from hooks');
  const root = await realpath(memory.localPath);
  const expected = resolve(root, 'buckets', bucket);
  const owner = await realpath(expected);
  const same = process.platform === 'win32' ? owner.toLowerCase() === expected.toLowerCase() : owner === expected;
  const target = resolve(expected, document);
  if (!same || !contained(expected, target)) throw new Error(`Bucket index resolves outside its configured owner: ${bucket}`);
  const canonical = await realpath(target);
  if (!contained(owner, canonical)) throw new Error(`Memory document resolves outside its bucket owner: ${bucket}`);
  const sameTarget = process.platform === 'win32' ? canonical.toLowerCase() === target.toLowerCase() : canonical === target;
  if (document === 'index.md' && !sameTarget) throw new Error(`Bucket index resolves outside its configured index owner: ${bucket}`);
  return canonical;
}

export async function memoryIndex(memory, bucket, document = 'index.md') {
  return readFile(await memoryPath(memory, bucket, document), 'utf8');
}

export async function memoryCatalog(memory) {
  if (!memory.repo) throw new Error('memory.repo is missing');
  if (!memory.localPath || !await exists(resolve(memory.localPath, '.git'))) throw new Error('The configured memory clone is missing');
  const expected = resolve(await realpath(memory.localPath), 'index.md');
  const canonical = await realpath(resolve(memory.localPath, 'index.md'));
  if (canonical !== expected) throw new Error('Root memory index resolves outside its configured owner');
  return bucketCatalog(await readFile(canonical, 'utf8'));
}

