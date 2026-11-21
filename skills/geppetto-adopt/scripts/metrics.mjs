import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { unlink } from 'node:fs/promises';
import { appendRecord, claimFile, recordContext } from './common.mjs';
import { logHookEvent } from './hook-events.mjs';
import { redactValue } from './signal.mjs';
import { commandArgs, commandSegments, toolCommand, toolName } from './turn-checks.mjs';

const minimumCommandMs = 5000;
const defaultSuite = /(?:^|[ :_-])(?:tests?|pytest|unittest|vitest|jest|check|lint|build|typecheck)(?:$|[ :_.-])/i;
export function structuredPrAction(event) {
  const match = /(?:^|__)github__(create|merge)_pull_request$|(?:^|__)github_(create|merge)_pull_request$|(?:^|__)pull_request_(create|merge)$/.exec(toolName(event));
  return match?.slice(1).find(Boolean);
}

const subcommandTools = /^(?:npm|pnpm|yarn|bun|git|gh|cargo|go|dotnet|make)$/;

export function metricOperation(event, config) {
  const tool = toolName(event);
  const prAction = structuredPrAction(event);
  if (prAction) return { kind: 'command', key: 'github pr ' + prAction, always: true };
  if (/^(?:Agent|Task|spawn_agent|delegate_task|wait_agent|task_result|t3_thread_wait)$/i.test(tool)) return { kind: 'delegate', key: tool.toLowerCase() };
  if (!/^(?:Bash|PowerShell|shell|exec_command)$/i.test(tool) || event.tool_input?.run_in_background) return;
  const command = toolCommand(event);
  if (typeof command !== 'string' || !command.trim()) return;
  const operators = command.trimStart().replace(/^&\s+/, '').replace(/"[^"\r\n]*"|'[^'\r\n]*'/g, '');
  if (/(?:^|\s)(?:nohup|Start-Process|Start-Job)\s|(?<![&<>])&(?![&>])/i.test(operators)) return;
  const commands = commandSegments(command).map(segment => commandArgs(segment, { strictPrefix: true }));
  for (const { positional } of commands) {
    const redirect = positional.findIndex(arg => /^\d*[<>]/.test(arg));
    if (redirect >= 0) positional.splice(redirect);
  }
  const { executable, positional, flags } = commands.find(part => part.executable && !/^(?:cd|set-location)$/i.test(part.executable)) ?? commands[0];
  const program = executable?.toLowerCase(), [first] = positional;
  if (!program || !/^[\w.-]+$/.test(program)) return;
  let parts = subcommandTools.test(program) ? positional.slice(0, first === 'run' && /^(?:npm|pnpm|yarn|bun)$/.test(program) ? 2 : 1) : [];
  if (/^(?:node|bun|python\d*|py|ruby|deno)$/.test(program) && /\.(?:[cm]?js|tsx?|py|rb)$/.test(first ?? '')) parts = [first.split(/[/\\]/).at(-1)];
  if (/^(?:python\d*|py)$/.test(program) && flags.has('-m') && /^(?:pytest|unittest)$/.test(first ?? '')) parts = ['-m', first];
  if (/^(?:npx|bunx)$/.test(program) && /^(?:vitest|jest|playwright)$/.test(first ?? '')) parts = positional.slice(0, /^(?:run|test)$/.test(positional[1] ?? '') ? 2 : 1);
  if (program === 'node' && flags.has('--test')) parts = ['--test'];
  const key = [program, ...parts.filter(part => /^[\w.:@-]+$/.test(part))].join(' ');
  const suite = config?.suites === undefined ? defaultSuite.test(key) : config.suites.some(pattern => new RegExp(pattern).test(key));
  const scoped = suite && (positional.length > (parts[0] === '--test' ? 0 : parts[0] === '-m' ? 1 : parts.length) || [...flags.keys()].some(flag => /^(?:-k|-t|-g|--grep|--filter|--test-name-pattern|--test-path-patterns?)$/.test(flag)));
  return redactValue({ kind: suite ? 'suite' : 'command', key, scoped, always: suite || /^(?:git|gh)$/.test(program) });
}

export async function finishMetric(root, state, event, records, endedAt) {
  const start = records.findLast(row => row.kind === 'PreToolUse' && row.id === event.tool_use_id);
  if (!start?.operation || endedAt < start.at) return;
  const { kind, key, scoped, always, limits } = start.operation, durationMs = endedAt - start.at;
  const response = event.tool_response, output = typeof response === 'string' ? response : '';
  if (kind !== 'delegate' && (response?.session_id || response?.sessionId || response?.backgroundTaskId || /(?:Process running with session ID|^Session ID:|Command running in background with ID)/im.test(output))) return;
  if (kind === 'command' && !always && durationMs < minimumCommandMs && !limits?.expectedMs && !limits?.warnMs) return;
  const claim = resolve(state, 'metric-' + createHash('sha256').update(event.tool_use_id).digest('hex'));
  if (!await claimFile(claim)) return;
  const exit = response?.exit_code ?? response?.exitCode ?? Number(output.match(/(?:Process exited with code |(?:^|\n)Exit code:?\s*)(-?\d+)/)?.[1]);
  const ok = event.tool_error || response?.isError || response?.is_error ? false : Number.isInteger(exit) ? exit === 0 : undefined;
  try {
    const identity = recordContext.getStore();
    const row = redactValue({ ts: new Date(endedAt).toISOString(), kind, key, scoped, durationMs, ...(limits && { limits }), metricId: createHash('sha256').update(event.session_id + ':' + event.tool_use_id).digest('hex'),
      ...(kind === 'delegate' && { startedAt: start.at, endedAt }), exit: Number.isInteger(exit) ? exit : undefined,
      ok, sessionId: event.session_id, turnId: event.turn_id ?? identity?.turnId ?? null, host: hostname(), ...identity });
    await appendRecord(root, 'metrics', row);
    return row;
  } catch (error) { await unlink(claim); throw error; }
}

export async function metricDiagnostic(root, event, error) {
  const diagnostic = redactValue({ hook: 'metrics', event: event.hook_event_name, error: error.message });
  try { await logHookEvent(root, diagnostic, event); }
  catch { console.error(`Geppetto metrics: ${JSON.stringify(diagnostic)}`); }
}
