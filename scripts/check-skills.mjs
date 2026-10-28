import { readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, isMain, UsageError, filesUnder } from '../skills/geppetto-adopt/scripts/common.mjs';
import { markdownLines } from '../skills/geppetto-adopt/scripts/gate-sections.mjs';
export const ownSkills = ['adopt', 'spec', 'build', 'verify', 'learn', 'memory', 'measure-it', 'x-ray', 'reuse-it', 'living-docs', 'behaviour-tests'].map(name => `geppetto-${name}`);
export const bundledSkills = ['writing-for-agents', 'requirements-blast-radius', 'skill-learning-patterns', 'code-review', 'receive-work-feedback', 'retro'];
const requiredTemplates = ['AGENTS.md', 'CLAUDE.md', 'pr-ticket.md', 'feature-doc.md', 'jobs/learn.md', 'jobs/curate-skills.md', 'jobs/maintain-memory.md', 'hooks/claude/settings.json', 'hooks/codex/.codex/hooks.json', 'ci/pr-gate.yml'];
/** Inspect the actual shipped inventory and local Markdown pointers without running tools or models. */
export function checkPack(root) {
  root = resolve(root); const errors = [];
  const fail = (path, line, message) => errors.push(`${relative(root, path).replaceAll('\\', '/')}:${line}: ${message}`);
  const requireFile = path => {
    const present = existsSync(path) && statSync(path).isFile();
    if (!present) fail(path, 1, 'Required file missing');
    return present;
  };
  const templates = resolve(root, 'skills/geppetto-adopt/assets/templates');
  for (const name of [...ownSkills, ...bundledSkills]) {
    const path = resolve(root, 'skills', name, 'SKILL.md');
    if (!requireFile(path)) continue;
    const text = readFileSync(path, 'utf8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!frontmatter || !frontmatter[1].includes(`name: ${name}`) || !/^description:\s*\S/m.test(frontmatter[1])) fail(path, 1, 'Skill needs matching name and nonempty description frontmatter');
    if (ownSkills.includes(name) && text.split(/\r?\n/).length > 250) fail(path, 1, 'Own skill exceeds 250-line entrypoint budget');
    if (bundledSkills.includes(name)) requireFile(resolve(root, 'skills', name, 'LICENSE.txt'));
  }
  for (const file of requiredTemplates) requireFile(resolve(templates, file));
  for (const file of ['README.md', 'THIRD_PARTY_NOTICES.md']) requireFile(resolve(root, file));
  for (const name of ['ponytail', 'TokenEconomizer', 'skill-diet']) requireFile(resolve(root, `integrations/${name}.md`));
  const claude = resolve(templates, 'CLAUDE.md');
  if (existsSync(claude) && readFileSync(claude, 'utf8').trim() !== '@AGENTS.md') fail(claude, 1, 'CLAUDE template must import AGENTS.md');
  const router = resolve(templates, 'AGENTS.md');
  if (existsSync(router)) {
    const bytes = readFileSync(router), lines = bytes.toString('utf8').trimEnd().split(/\r?\n/).length;
    if (lines < 60 || lines > 120 || bytes.length > 16384) fail(router, 1, 'Router template must fit 60–120 lines and 16384 bytes');
  }
  const documents = existsSync(resolve(root, 'skills')) ? filesUnder(resolve(root, 'skills'), { skipLinks: true }).filter(path => path.endsWith('.md')) : [];
  if (existsSync(resolve(root, 'integrations'))) documents.push(...filesUnder(resolve(root, 'integrations')).filter(path => path.endsWith('.md')));
  documents.push(...['README.md', 'THIRD_PARTY_NOTICES.md'].map(name => resolve(root, name)).filter(existsSync));
  let localLinks = 0;
  for (const path of documents) {
    for (const [index, line] of markdownLines(readFileSync(path, 'utf8')).entries()) {
      for (const match of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1].replace(/^<|>$/g, '').split('#')[0];
        if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('{{')) continue;
        localLinks += 1;
        if (!existsSync(resolve(dirname(path), decodeURIComponent(target)))) fail(path, index + 1, `Unresolved local link: ${target}`);
      }
    }
  }
  return { errors, skills: ownSkills.length + bundledSkills.length, templates: requiredTemplates.length, localLinks };
}
if (isMain(import.meta.url)) await cli(args => {
  if (args.length > 1) throw new UsageError('Usage: node scripts/check-skills.mjs [pack-root]');
  const result = checkPack(args[0] || resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  for (const error of result.errors) console.error(error);
  console.log(`${result.errors.length ? 'FAIL' : 'PASS'}: ${result.skills} skills, ${result.templates} templates, ${result.localLinks} local links; ${result.errors.length} errors.`);
  return result.errors.length ? 1 : 0;
});
