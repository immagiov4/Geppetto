import { appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { cli, isMain, parseArgs, UsageError, ignoreLocalFiles } from './common.mjs';

export function redact(text) {
  return text.replace(/\b(?:sk-(?:proj-|or-v1-)?[a-z\d_-]{12,}|gh[pousr]_[a-z\d_]{12,}|github_pat_[a-z\d_]{12,}|AKIA[A-Z\d]{16})\b/gi, '[REDACTED]')
    .replace(/\b(Bearer)\s+[^\s"']+/gi, '$1 [REDACTED]')
    .replace(/\b([a-z\d_]*(?:api[_-]?key|token|secret|password))["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

export async function main(args) {
  const opts = parseArgs(args, { values: ['--metric', '--scope', '--kind'] });
  const kind = opts['--kind'] ?? 'friction';
  if (opts._.length !== 1 || !opts._[0].trim() || !opts['--metric']?.trim() || !['error', 'friction', 'preference', 'optimisation'].includes(kind)) throw new UsageError('Usage: signal.mjs "<text>" --metric <name> [--scope <s>] [--kind error|friction|preference|optimisation]');
  await ignoreLocalFiles('.', ['/signals.jsonl']);
  const entry = { id: randomUUID(), ts: new Date().toISOString(), kind, scope: redact(opts['--scope'] ?? 'project'), metric: redact(opts['--metric']), text: redact(opts._[0]) };
  await appendFile('.geppetto/signals.jsonl', `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  console.log(`Signal recorded: ${entry.id}`); return 0;
}

if (isMain(import.meta.url)) await cli(main);
