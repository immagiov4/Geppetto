import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ownSkills = [
  'adopt', 'spec', 'build', 'verify', 'learn', 'memory', 'authorize',
  'measure-it', 'x-ray', 'reuse-it', 'living-docs', 'behaviour-tests',
].map(name => `geppetto-${name}`);
export const bundledSkills = [
  'writing-for-agents', 'requirements-blast-radius', 'skill-learning-patterns',
  'code-review', 'receiving-pr-reviews', 'retro',
];
const requiredTemplates = [
  'AGENTS.md', 'CLAUDE.md', 'pr-ticket.md', 'feature-doc.md', 'authorizations',
  'jobs/learn.md', 'jobs/curate-skills.md', 'jobs/maintain-memory.md',
  'hooks/claude/settings.json', 'hooks/codex/.codex/hooks.json', 'ci/pr-gate.yml',
];

function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) return [];
      return entry.isDirectory() ? filesUnder(path) : [path];
    });
}

function proseLines(text) {
  let fence = null;
  return text.split(/\r?\n/).flatMap((line, index) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence ? null : marker;
      return [];
    }
    return fence ? [] : [{ line, number: index + 1 }];
  });
}

/** Inspect the actual shipped inventory and local Markdown pointers without running tools or models. */
export function checkPack(root) {
  root = resolve(root);
  const errors = [];
  const fail = (path, line, message) => errors.push(`${relative(root, path).replaceAll('\\', '/')}:${line}: ${message}`);
  const requireFile = path => {
    if (!existsSync(path) || !statSync(path).isFile()) {
      fail(path, 1, 'Required file missing');
      return false;
    }
    return true;
  };
  const templates = resolve(root, 'skills/geppetto-adopt/assets/templates');
  for (const name of [...ownSkills, ...bundledSkills]) {
    const path = resolve(root, 'skills', name, 'SKILL.md');
    if (!requireFile(path)) continue;
    const text = readFileSync(path, 'utf8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!frontmatter || !frontmatter[1].includes(`name: ${name}`) || !/^description:\s*\S/m.test(frontmatter[1])) {
      fail(path, 1, 'Skill needs matching name and nonempty description frontmatter');
    }
    if (ownSkills.includes(name) && text.split(/\r?\n/).length > 250) {
      fail(path, 1, 'Own skill exceeds 250-line entrypoint budget');
    }
    if (bundledSkills.includes(name)) requireFile(resolve(root, 'skills', name, 'LICENSE.txt'));
  }
  for (const file of requiredTemplates) requireFile(resolve(templates, file));
  for (const file of ['README.md', 'THIRD_PARTY_NOTICES.md']) requireFile(resolve(root, file));
  const grants = resolve(templates, 'authorizations');
  if (existsSync(grants) && readFileSync(grants).length !== 0) fail(grants, 1, 'Authorization template must start empty');
  const claude = resolve(templates, 'CLAUDE.md');
  if (existsSync(claude) && readFileSync(claude, 'utf8').trim() !== '@AGENTS.md') fail(claude, 1, 'CLAUDE template must import AGENTS.md');
  const router = resolve(templates, 'AGENTS.md');
  if (existsSync(router)) {
    const bytes = readFileSync(router);
    const lines = bytes.toString('utf8').trimEnd().split(/\r?\n/).length;
    if (lines < 60 || lines > 120 || bytes.length > 16384) fail(router, 1, 'Router template must fit 60–120 lines and 16384 bytes');
  }
  const documents = [
    ...filesUnder(resolve(root, 'skills')).filter(path => path.endsWith('.md')),
    ...['README.md', 'THIRD_PARTY_NOTICES.md'].map(name => resolve(root, name)).filter(existsSync),
  ];
  let localLinks = 0;
  for (const path of documents) {
    for (const { line, number } of proseLines(readFileSync(path, 'utf8'))) {
      for (const match of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1].replace(/^<|>$/g, '').split('#')[0];
        if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('{{')) continue;
        localLinks += 1;
        if (!existsSync(resolve(dirname(path), decodeURIComponent(target)))) fail(path, number, `Unresolved local link: ${target}`);
      }
    }
  }
  return { errors, skills: ownSkills.length + bundledSkills.length, templates: requiredTemplates.length, localLinks };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) {
    process.stderr.write('Usage: node scripts/check-skills.mjs [pack-root]\n');
    process.exitCode = 2;
  } else {
    const root = process.argv[2] || resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const result = checkPack(root);
    for (const error of result.errors) process.stderr.write(`${error}\n`);
    process.stdout.write(`${result.errors.length ? 'FAIL' : 'PASS'}: ${result.skills} skills, ${result.templates} templates, ${result.localLinks} local links; ${result.errors.length} errors.\n`);
    process.exitCode = result.errors.length ? 1 : 0;
  }
}
