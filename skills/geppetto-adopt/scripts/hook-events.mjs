import { resolve, relative } from 'node:path';
import { appendRecord, projectRoot, userHome, contained, exists } from './common.mjs';
import { isWeeklyReport } from './weekly-report.mjs';
import { memorySettings } from './memory-config.mjs';
import { commandArgs, commandSegments, toolName, toolCommand } from './turn-checks.mjs';
export function readKind(path, memory, root) { if (/[/\\]SKILL\.md$/i.test(path)) return 'skill';
  if (isWeeklyReport(root, path)) return 'weekly-report';
  return memory?.localPath && contained(memory.localPath, path) && /\.md$/i.test(path) ? 'memory' : null; }
const searchValueFlags = new Set(['-e', '--regexp', '-f', '--file', '-g', '--glob', '-t', '--type', '-T', '--type-not', '-m', '--max-count', '-r', '--replace', '-A', '-B', '-C', '--after-context', '--before-context', '--context']);
function reportFileArguments(command) {
  return new Set(commandSegments(command).flatMap(segment => {
    const { executable, positional, flags } = commandArgs(segment, { argumentFlags: searchValueFlags });
    if (/^(?:cat|Get-Content|type)$/i.test(executable ?? '')) return positional;
    if (!/^(?:rg|sed)$/i.test(executable ?? '') || flags.has('--files')) return [];
    return flags.has('-e') || flags.has('--regexp') || flags.has('-f') || flags.has('--file') ? positional : positional.slice(1);
  }));
}
/** Successful reads log paths only; shell extraction deliberately requires an explicit read command. */
export async function logReads(event, { home = userHome(), readRoot, reference } = {}) {
  if (event.hook_event_name !== 'PostToolUse' || !event.session_id || event.tool_error || event.tool_response?.isError || event.tool_response?.is_error || event.tool_response?.exit_code || event.tool_response?.exitCode || typeof event.tool_response === 'string' && /(?:Process exited with code |(?:^|\n)Exit code:?\s*)-?[1-9]\d*/.test(event.tool_response)) return;
  const root = await projectRoot(event.cwd ?? '.'), memory = await memorySettings(root, home), input = event.tool_input; const command = toolCommand(event), direct = /^(read|read_file|read_text_file)$/i.test(toolName(event)); const readCommands = (command.match(/(?:[^"';&|\r\n]|"(?:\\.|[^"\\])*"|'[^']*')+/g) ?? []).filter(part => /^\s*(?:Get-Content|cat|type|sed|rg)\b/i.test(part) && !/^\s*rg\s+--files\b/.test(part)).join('\n'); const names = direct ? [input?.file_path ?? input?.path ?? input?.Path] : /(?:^|[;|\n])\s*(?:Get-Content|cat|type|sed|rg)\b/i.test(command) ? [...readCommands.matchAll(/"([^"\r\n]+\.md)"|'([^'\r\n]+\.md)'|([^\s"';|]+\.md)\b/gi)].map(match => match[1] ?? match[2] ?? match[3]) : [];
  const reportArguments = direct ? null : reportFileArguments(command);
  for (const name of new Set(names.filter(name => typeof name === 'string' && !name.includes('$')))) {
    const path = resolve(input?.workdir ?? input?.cwd ?? event.cwd ?? root, name), sourcePath = readRoot && contained(readRoot, path) ? resolve(root, relative(readRoot, path)) : path;
    const kind = readKind(sourcePath, memory, root);
    if (kind === 'weekly-report' && (reportArguments && !reportArguments.has(name) || !await exists(sourcePath))) continue;
    if (kind) await appendRecord(root, 'reads', { ts: new Date().toISOString(), session: event.session_id, kind, path: sourcePath, ...(sourcePath !== path && { readPath: path, reference }) });
  }
}
export async function logHookEvent(project, event, context = {}) {
  const identity = Object.fromEntries([['sessionId', context.session_id], ['turnId', context.turn_id]]
    .filter(([, value]) => typeof value === 'string' && value.trim()));
  await appendRecord(project, 'hook-events', { ts: new Date().toISOString(), ...event, ...identity });
}
