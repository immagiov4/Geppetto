import { cli, isMain, hookMain, projectRoot, UsageError } from './common.mjs';
import { classifySkills } from './skill-selector.mjs';
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
  return hookMain(args, 'Skill hook', handleSkillEvent);
}
if (isMain(import.meta.url)) await cli(main);
