import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { cli, isMain, parseArgs, UsageError, jsonFile, contained } from './common.mjs';
import { markdownLines, markdownHeadings } from './gate-sections.mjs';
const hash = text => createHash('sha256').update(text).digest('hex');
const normalize = text => text.replace(/\s+/g, ' ').trim();
/** Snapshot every direct section body, including heading-free introductory content. */
function inventory(sourceText) {
  const lines = sourceText.replace(/\r\n/g, '\n').split('\n');
  const headings = markdownHeadings(markdownLines(sourceText));
  if (!headings.length || normalize(lines.slice(0, headings[0].line).join('\n'))) headings.unshift({ title: 'Preamble', line: 0, start: 0, level: 0 });
  return headings.map((heading, index) => {
    const content = lines.slice(heading.start, headings[index + 1]?.line ?? lines.length).join('\n').trim();
    return { id: `section-${index + 1}`, title: heading.title, line: heading.line + 1, content, sha256: hash(content) };
  });
}
async function verifyMigration(snapshot, dispositions, root, inventoryPath) {
  if (snapshot.version !== 1 || typeof snapshot.sourceText !== 'string' || snapshot.sha256 !== hash(snapshot.sourceText) || JSON.stringify(snapshot.sections) !== JSON.stringify(inventory(snapshot.sourceText))) throw new Error(`${inventoryPath}:1: Inventory snapshot is incomplete or changed; regenerate from the preserved original`);
  if (!dispositions || typeof dispositions !== 'object' || Array.isArray(dispositions)) throw new Error('Migration map must be an object keyed by section id');
  const errors = []; let preserved = 0; let dropped = 0;
  const ids = new Set(snapshot.sections.map(section => section.id));
  for (const id of Object.keys(dispositions)) if (!ids.has(id)) errors.push(`Unknown section disposition: ${id}`);
  for (const section of snapshot.sections) {
    const entry = dispositions[section.id]; const label = `${snapshot.source}:${section.line}: ${section.title}`;
    if (entry && typeof entry.dropped === 'string' && entry.dropped.trim() && !entry.owners) { dropped++; continue; }
    if (!entry || entry.dropped !== undefined || !Array.isArray(entry.owners) || !entry.owners.length || entry.owners.some(owner => typeof owner !== 'string' || !owner.trim())) { errors.push(`${label}: Name owner files or a reasoned intentionally-dropped disposition`); continue; }
    const owners = [];
    for (const owner of entry.owners) {
      const path = resolve(root, owner);
      if (!contained(root, path)) { errors.push(`${label}: Owner path escapes the project: ${owner}`); continue; }
      try { owners.push(normalize(await readFile(path, 'utf8'))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; errors.push(`${label}: Owner file missing: ${owner}`); }
    }
    // Whole paragraphs may move to different owners; every original paragraph must survive.
    const paragraphs = section.content.split(/\n\s*\n/).map(normalize).filter(Boolean);
    if (paragraphs.some(paragraph => !owners.some(owner => owner.includes(paragraph)))) errors.push(`${snapshot.source}:${section.line}: Section content missing at named owners: ${section.title}`);
    else if (owners.length === entry.owners.length) preserved++;
  }
  return { errors, preserved, dropped };
}
export async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('migrate-agents.mjs inventory --source <preserved-original.md> > inventory.json\nmigrate-agents.mjs verify --inventory <snapshot.json> --map <dispositions.json> [--project <dir>]\nMap each section id to {"owners":["project-relative.md"]} or {"dropped":"owner-approved reason"}. Every original paragraph must appear at a named owner; whitespace and line wrapping are normalized. Keep the snapshot outside the overwritten instruction file.'); return 0;
  }
  const opts = parseArgs(args, { values: ['--source', '--inventory', '--map', '--project'] });
  const [command] = opts._;
  if (opts._.length !== 1 || !['inventory', 'verify'].includes(command) || (command === 'inventory' ? !opts['--source'] || opts['--inventory'] || opts['--map'] || opts['--project'] : !opts['--inventory'] || !opts['--map'] || opts['--source'])) throw new UsageError('Usage: migrate-agents.mjs inventory --source <original.md> > inventory.json; verify --inventory <snapshot.json> --map <dispositions.json> [--project <dir>]');
  if (command === 'inventory') {
    const sourceText = await readFile(opts['--source'], 'utf8');
    console.log(JSON.stringify({ version: 1, source: opts['--source'], sha256: hash(sourceText), sourceText, sections: inventory(sourceText) }, null, 2)); return 0;
  }
  const result = await verifyMigration(await jsonFile(opts['--inventory']), await jsonFile(opts['--map']), resolve(opts['--project'] ?? '.'), opts['--inventory']);
  if (result.errors.length) { console.error(result.errors.join('\n')); return 1; }
  console.log(`Migration OK (${result.preserved + result.dropped} sections: ${result.preserved} preserved, ${result.dropped} intentionally dropped)`); return 0;
}
if (isMain(import.meta.url)) await cli(main);
