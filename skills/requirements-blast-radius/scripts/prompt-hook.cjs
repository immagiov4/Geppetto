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
  const localHook = path.join(
    directory,
    '.agents/skills/requirements-blast-radius/scripts/prompt-hook.cjs'
  );
  const settings = path.join(
    directory,
    client === 'claude' ? '.claude/settings.json' : '.codex/hooks.json'
  );
  if (fs.existsSync(localHook) && fs.existsSync(settings)) {
    const groups = JSON.parse(fs.readFileSync(settings, 'utf8')).hooks?.UserPromptSubmit || [];
    const projectMarker = ` --client ${client} --requirements-project-hook`;
    const declared = groups.some(group =>
      group.hooks?.some(
        handler => handler.type === 'command' && handler.command?.endsWith(projectMarker)
      )
    );
    if (declared) {
      if (!process.argv.includes('--requirements-project-hook')) process.exit(0);
      break;
    }
  }
  if (fs.existsSync(path.join(directory, '.git'))) break;
  const parent = path.dirname(directory);
  if (parent === directory) break;
  directory = parent;
}
const instruction =
  'Does this message change the agreed task requirements? For substantial changes, use $requirements-blast-radius and create or update the Requirements map; reuse a supplied map and handle tiny local changes directly.\n' +
  'Is this feedback on your work? Use $receive-work-feedback to check the requested outcome and supporting evidence before revising.';
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: process.argv.includes('--requirements-project-hook')
        ? instruction +
          ' Use the repository skill at .agents/skills/requirements-blast-radius/SKILL.md, resolved from the Git root, and resolve its references from that directory.'
        : instruction,
    },
  })
);
