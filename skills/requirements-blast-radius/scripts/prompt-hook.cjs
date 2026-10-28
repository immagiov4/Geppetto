/** Local prompt-context hook. The model judges scope and message provenance. */
const fs = require('node:fs');
const path = require('node:path');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
if (input.hook_event_name && input.hook_event_name !== 'UserPromptSubmit') process.exit(0);
if (typeof input.prompt !== 'string' || !input.prompt.trim()) process.exit(0);
// A declared project hook owns injection; its version wins over a global copy.
const client = process.argv[process.argv.indexOf('--client') + 1];
if (!['claude', 'codex'].includes(client)) throw new Error('Pass --client claude or codex');
let directory = path.resolve(input.cwd || process.cwd());
while (true) {
  const localHook = path.join(directory, '.agents/skills/requirements-blast-radius/scripts/prompt-hook.cjs');
  const settings = path.join(directory, client === 'claude' ? '.claude/settings.json' : '.codex/hooks.json');
  if (fs.existsSync(settings)) {
    const groups = JSON.parse(fs.readFileSync(settings, 'utf8')).hooks?.UserPromptSubmit || [];
    const integrated = groups.flatMap(group => group.hooks ?? []).map(handler => handler.type === 'command' && /^node "([^"]+\/geppetto-adopt\/scripts\/hook\.mjs)"$/.exec(handler.command ?? '')?.[1]);
    if (integrated.some(script => script && fs.existsSync(script) && fs.existsSync(path.resolve(path.dirname(script), '../../requirements-blast-radius/scripts/message-context.cjs')))) process.exit(0);
    const projectMarker = ` --client ${client} --requirements-project-hook`;
    const declared = groups.some(group => group.hooks?.some(handler => handler.type === 'command' && handler.command?.endsWith(projectMarker)));
    if (fs.existsSync(localHook) && declared) {
      if (!process.argv.includes('--requirements-project-hook')) process.exit(0);
      break;
    }
  }
  if (fs.existsSync(path.join(directory, '.git'))) break;
  const parent = path.dirname(directory);
  if (parent === directory) break;
  directory = parent;
}
let additionalContext = require('./message-context.cjs');
if (process.argv.includes('--requirements-project-hook')) additionalContext += ' Use the repository skill at .agents/skills/requirements-blast-radius/SKILL.md, resolved from the Git root, and resolve its references from that directory.';
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }));
