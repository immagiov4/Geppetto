import { readFile, writeFile, mkdir, readdir, lstat, realpath } from 'node:fs/promises';
import { resolve, relative, dirname, sep, matchesGlob } from 'node:path';
import { createInterface } from 'node:readline';
import { contained, isMain } from './common.mjs';
import { redact } from './signal.mjs';

const blocked = part => /^(?:\.git|\.geppetto|\.codex|\.claude|\.agents|node_modules|private|\.env(?:\..*)?|.*\.(?:pem|key))$/i.test(part);
export class LearningScopeError extends Error {}
export async function learningFilePath(root, name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) throw new LearningScopeError('A project-relative file path is required');
  const path = resolve(root, name);
  if (!contained(root, path) || path === root || relative(root, path).split(sep).some(blocked)) throw new LearningScopeError('File is outside the learning scope');
  for (let current = path; current !== root; current = dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new LearningScopeError('Learning file paths must not use symbolic links'); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  return path;
}
async function listFiles(root, directory = root) {
  const names = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (blocked(entry.name) || entry.isSymbolicLink()) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) names.push(...await listFiles(root, path));
    else if (entry.isFile()) names.push(relative(root, path).split(sep).join('/'));
  }
  return names;
}

/** File-only MCP boundary; neither shell, delegation nor publication is exposed. */
export async function learningFileTool(root, name, args, readOnly = false, referenceRoot = null) {
  root = await realpath(root);
  if (name === 'Read' && referenceRoot) {
    referenceRoot = await realpath(referenceRoot);
    const path = resolve(root, args.path);
    if (contained(referenceRoot, path)) return redact(await readFile(await learningFilePath(referenceRoot, path), 'utf8'));
  }
  if (name === 'Glob' || name === 'Grep') {
    const files = (await listFiles(root)).filter(file => matchesGlob(file, args.glob ?? '**/*'));
    if (name === 'Glob') return files.join('\n');
    if (typeof args.text !== 'string' || !args.text) throw new Error('Grep needs literal text');
    const found = [];
    for (const file of files) {
      const text = await readFile(await learningFilePath(root, file), 'utf8');
      for (const [index, line] of text.split(/\r?\n/).entries()) if (line.includes(args.text)) found.push(`${file}:${index + 1}:${redact(line)}`);
    }
    return found.join('\n');
  }
  const path = await learningFilePath(root, args.path);
  if (name === 'Read') return redact(await readFile(path, 'utf8'));
  if (readOnly || !['Edit', 'Write'].includes(name)) throw new Error('Tool is unavailable in this learning phase');
  let content;
  if (name === 'Write') {
    if (typeof args.content !== 'string') throw new Error('Write needs text content');
    content = args.content;
  } else {
    if (typeof args.oldText !== 'string' || !args.oldText || typeof args.newText !== 'string') throw new Error('Edit needs oldText and newText');
    const original = await readFile(path, 'utf8');
    if (original.split(args.oldText).length !== 2) throw new Error('Edit requires exactly one matching occurrence');
    content = original.replace(args.oldText, () => args.newText);
  }
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, content);
  return 'Saved project file';
}

const schemas = {
  Read: { path: { type: 'string' } },
  Write: { path: { type: 'string' }, content: { type: 'string' } },
  Edit: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } },
  Glob: { glob: { type: 'string' } },
  Grep: { text: { type: 'string' }, glob: { type: 'string' } },
};
if (isMain(import.meta.url)) {
  const root = resolve(process.argv[2]); const readOnly = process.argv[3] === 'read-only';
  const allowed = JSON.parse(process.argv[4] ?? '[]');
  const referenceRoot = process.argv[5] ?? null;
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const request = JSON.parse(line); if (request.id === undefined) continue;
    let result;
    if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'geppetto-learning-files', version: '1.0.0' } };
    else if (request.method === 'tools/list') result = { tools: Object.entries(schemas).filter(([name]) => allowed.includes(name) && (!readOnly || !['Write', 'Edit'].includes(name))).map(([name, properties]) => ({ name, description: `${name} project files within the learning boundary`, inputSchema: { type: 'object', properties, required: Object.keys(properties).filter(key => key !== 'glob'), additionalProperties: false } })) };
    else if (request.method === 'tools/call') {
      try {
        if (!allowed.includes(request.params.name)) throw new Error('Tool outside the configured selection');
        result = { content: [{ type: 'text', text: await learningFileTool(root, request.params.name, request.params.arguments, readOnly, referenceRoot) }] };
      }
      catch { result = { isError: true, content: [{ type: 'text', text: 'File operation rejected; verify the project path, tool and exact edit match.' }] }; }
    } else if (request.method === 'ping') result = {};
    else { console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method unavailable' } })); continue; }
    console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  }
}
