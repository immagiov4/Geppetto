import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { cli, isMain, parseArgs, projectRoot, jsonFile, UsageError, exists } from './common.mjs';
import { learningStep, learningStatus } from './learn-dispatch.mjs';
import { cliLearningHost, hermesLearningHost } from './learn-hosts.mjs';
import { resolve } from 'node:path';

export async function handleLearningHostEvent(event, name, options = {}) {
  if (process.env.GEPPETTO_LEARNING_CHILD === '1' || !['PostToolUse', 'Stop', 'SessionStart'].includes(event?.hook_event_name) || event.stop_hook_active) return {};
  const root = await projectRoot(event.cwd ?? '.');
  if (!await exists(resolve(root, '.geppetto/signals.jsonl'))) return {};
  const policy = options.policy ?? (await jsonFile(resolve(root, '.geppetto/config.json'), {})).hooks?.signalLearning;
  const configured = policy?.hosts?.[name] ?? {};
  const nativeOptions = Object.fromEntries(['executable', 'model', 'sandbox', 'tools', 'boundary', 'provider', 'budgetControl'].filter(key => configured[key] !== undefined).map(key => [key, configured[key]]));
  const host = options.host ?? (['codex', 'claude'].includes(name) && policy?.enabled ? cliLearningHost(name, nativeOptions) : undefined);
  await learningStep(root, { ...options, policy, host });
  // Async command-hook output is informational. It is never a native dispatch acknowledgement.
  return {};
}

export async function main(args) {
  const opts = parseArgs(args, { values: ['--host', '--project'], flags: ['--status', '--hermes-rpc'] });
  if (opts['--status']) { console.log(JSON.stringify(await learningStatus(opts['--project'] ?? '.'))); return 0; }
  if (opts['--hermes-rpc']) {
    if (!opts['--project']) throw new UsageError('Hermes RPC requires a project');
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
    const transport = async request => {
      console.log(JSON.stringify({ rpc: request }));
      const line = await lines.next(); if (line.done) throw new Error('Hermes lifecycle bridge disconnected');
      const response = JSON.parse(line.value); if (response.error) throw new Error(response.error);
      return response;
    };
    const result = await learningStep(opts['--project'], { host: hermesLearningHost(transport) });
    console.log(JSON.stringify({ done: { status: result.status, reason: result.reason } }));
    process.stdin.destroy(); return 0;
  }
  if (!['codex', 'claude'].includes(opts['--host'])) throw new UsageError('Usage: learn-host.mjs --host codex|claude < native-event.json; --status [--project <root>]');
  console.log(JSON.stringify(await handleLearningHostEvent(JSON.parse(readFileSync(0, 'utf8')), opts['--host']))); return 0;
}
if (isMain(import.meta.url)) await cli(main);
