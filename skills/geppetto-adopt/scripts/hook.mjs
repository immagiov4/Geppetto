import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { cli, isMain, run, UsageError } from './common.mjs';
import { redact } from './signal.mjs';
import { learningEvent } from './learn-nudge.mjs';

function words(command) {
  return [...command.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s]+)/g)].map(m => m[1] !== undefined ? m[1].replace(/\\(["\\])/g, '$1') : m[2] ?? m[3]);
}
function option(tokens, names) {
  for (let i = 0; i < tokens.length; i++) {
    if (names.includes(tokens[i])) return tokens[i + 1];
    for (const name of names) if (tokens[i].startsWith(`${name}=`)) return tokens[i].slice(name.length + 1);
  }
}

function sectionFeedback(body, cwd, runCommand) {
  const result = runCommand(process.execPath, [fileURLToPath(new URL('./gate-sections.mjs', import.meta.url)), '--pr', '-'], { cwd, input: body });
  if (result.status === 0) return 'Geppetto: PR sections pass.';
  return `Geppetto PR feedback: ${redact(result.stderr?.trim() || result.error?.message || 'Section check failed')}. Update the PR body before publishing; CI repeats this check.`;
}

function messageContext(event) {
  if (process.env.GEPPETTO_LEARNING_CHILD === '1' || typeof event.prompt !== 'string' || !event.prompt.trim()) return {};
  const modulePath = new URL(import.meta.url.endsWith('/scripts/hook.mjs')
    ? '../../requirements-blast-radius/scripts/message-context.cjs'
    : './message-context.cjs', import.meta.url);
  const additionalContext = createRequire(import.meta.url)(fileURLToPath(modulePath));
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } };
}

export async function handleEvent(event, { runCommand = run, now = Date.now } = {}) {
  if (!event || typeof event !== 'object') throw new UsageError('Hook input must be an event object');
  const learning = await learningEvent(event, now);
  if (event.hook_event_name === 'UserPromptSubmit') return messageContext(event);
  if (['PostToolUse', 'Stop'].includes(event.hook_event_name)) return learning;
  if (typeof event.tool_name !== 'string' || !event.tool_input) throw new UsageError('Hook input needs tool_name and tool_input');
  const input = event.tool_input;
  const eventName = event.hook_event_name ?? 'PreToolUse';
  const command = typeof input === 'string' ? input : input.command ?? input.cmd ?? '';
  const cwd = resolve(input.cwd ?? input.workdir ?? event.cwd ?? '.');
  if (/\bgh\s+pr\s+create\b/.test(command)) {
    const tokens = words(command); const bodyFile = option(tokens, ['--body-file', '-F']); const body = option(tokens, ['--body', '-b']);
    let feedback;
    if (bodyFile && bodyFile !== '-') {
      try { feedback = sectionFeedback(readFileSync(resolve(cwd, bodyFile), 'utf8'), cwd, runCommand); }
      catch (error) { feedback = `Geppetto: PR body file could not be checked (${error.code ?? 'read error'}). Run gate-sections.mjs --pr <file> before creating the PR.`; }
    } else if (body !== undefined) feedback = sectionFeedback(body, cwd, runCommand);
    else feedback = 'Geppetto: provide --body-file <file> and run gate-sections.mjs --pr <file> before creating the PR. CI checks the final PR body.';
    return { hookSpecificOutput: { hookEventName: eventName, additionalContext: feedback } };
  }
  if (/\bgit\s+(?:-[^\s]+\s+)*push\b/.test(command)) {
    const pr = runCommand('gh', ['pr', 'view', '--json', 'body'], { cwd });
    let feedback = 'Geppetto: current PR body is unavailable. Run gate-sections.mjs --pr <body-file> before pushing; CI checks the final PR body.';
    if (pr.status === 0) {
      try { const body = JSON.parse(pr.stdout).body; if (typeof body === 'string') feedback = sectionFeedback(body, cwd, runCommand); }
      catch { feedback = 'Geppetto: gh returned an unreadable PR body; run gate-sections.mjs --pr <body-file>. CI checks the final PR body.'; }
    }
    return { hookSpecificOutput: { hookEventName: eventName, additionalContext: feedback } };
  }
  return {};
}

export async function main(args) {
  if (args.length) throw new UsageError('Usage: hook.mjs < hook-event.json');
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8')); } catch { throw new UsageError('Hook input must be JSON'); }
  console.log(JSON.stringify(await handleEvent(event))); return 0;
}

if (isMain(import.meta.url)) await cli(main);
