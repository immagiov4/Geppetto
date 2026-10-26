import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, isMain, run, UsageError } from './common.mjs';
import { redact } from './signal.mjs';
import { learningEvent } from './learn-nudge.mjs';

const protectedPath = path => typeof path === 'string' && /(?:^|\/)\.geppetto\/authorizations$/i.test(resolve(path.replaceAll('\\', '/').replaceAll('"', '').replaceAll("'", '')).replaceAll('\\', '/'));
function writeTouchesGrant(tool, input) {
  if (/^(?:Write|Edit|MultiEdit|write_file|edit_file)$/i.test(tool)) return protectedPath(input.file_path ?? input.path);
  const command = typeof input === 'string' ? input : input.command ?? input.cmd ?? input.patch ?? '';
  if (/apply_patch$/i.test(tool)) return command.split(/\r?\n/).some(line => /^\*\*\* (?:Add File|Update File|Delete File|Move to): /.test(line) && protectedPath(line.slice(line.indexOf(': ') + 2)));
  // Catch literal shell destinations; arbitrary script side effects require provider-side limits.
  const tokens = words(command);
  if (tokens.some((token, i) => /^>>?/.test(token) && protectedPath(token.replace(/^>>?/, '') || tokens[i + 1]))) return true;
  return tokens.some(token => /^(?:Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|rm|mv|cp|tee)$/i.test(token)) && tokens.some(protectedPath);
}

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

export async function handleEvent(event, { runCommand = run, now = Date.now } = {}) {
  if (!event || typeof event !== 'object') throw new UsageError('Hook input must be an event object');
  const learning = await learningEvent(event, now);
  if (['UserPromptSubmit', 'PostToolUse', 'Stop'].includes(event.hook_event_name)) return learning;
  if (typeof event.tool_name !== 'string' || !event.tool_input) throw new UsageError('Hook input needs tool_name and tool_input');
  const input = event.tool_input;
  const eventName = event.hook_event_name ?? 'PreToolUse';
  if (writeTouchesGrant(event.tool_name, input)) return { hookSpecificOutput: { hookEventName: eventName, permissionDecision: 'deny', permissionDecisionReason: 'Authorization files record owner consent. Ask the owner to edit the grant through a trusted channel.' } };
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
