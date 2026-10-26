import { readFileSync } from 'node:fs';
import { cli, isMain, projectRoot, UsageError } from './common.mjs';
import { classifySkills } from './memory-classifier.mjs';

export async function handleSkillEvent(event, options = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new UsageError('Skill hook input must be an event object');
  if (process.env.GEPPETTO_LEARNING_CHILD === '1' || event.hook_event_name !== 'UserPromptSubmit' || typeof event.prompt !== 'string' || !event.prompt.trim()) return {};
  return classifySkills(event, { ...options, project: await projectRoot(event.cwd ?? '.') });
}

export async function main(args) {
  if (args.length === 1 && args[0] === '--check-credential') {
    const present = Boolean(process.env.OPENROUTER_API_KEY);
    console.log(JSON.stringify({ credential: present ? 'present' : 'missing', source: present ? 'process-environment' : null, providerAuthentication: 'not-verified' }));
    return present ? 0 : 1;
  }
  if (args.length) throw new UsageError('Usage: skill-hook.mjs [--check-credential] < hook-event.json');
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8')); } catch { throw new UsageError('Skill hook input must be JSON'); }
  console.log(JSON.stringify(await handleSkillEvent(event))); return 0;
}
if (isMain(import.meta.url)) await cli(main);
