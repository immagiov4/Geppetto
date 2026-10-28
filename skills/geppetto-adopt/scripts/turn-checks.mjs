import { UsageError } from './common.mjs';
import { readFileSync } from 'node:fs';
export const defaultTurnChecks = JSON.parse(readFileSync(new URL('./turn-checks.json', import.meta.url), 'utf8'));
export const turnPolicy = ({ turnChecks }) => ({ ...defaultTurnChecks, ...(Array.isArray(turnChecks) ? { checks: turnChecks } : turnChecks) });
export function validateTurnPolicy(config) {
  const supplied = config.turnChecks, policy = turnPolicy(config);
  const valid = text => typeof text === 'string' && text.trim() && !/[\r\n]/.test(text);
  const reserved = ['continuation', 'review', 'userCorrection', 'requestedAt', 'decidedAt', 'decisions', 'addedSeconds', 'edited', 'sessionId', 'turnId', 'previousTurnId', 'ts', 'transcriptOffset', '__proto__', 'constructor', 'prototype'];
  if (supplied !== undefined && !Array.isArray(supplied) && (!supplied || typeof supplied !== 'object' || Object.keys(supplied).some(key => !['checks', 'rearmOn'].includes(key))) || !Array.isArray(policy.checks) || policy.checks.some(check => !check || !/^[a-z][\w-]*$/.test(check.id) || reserved.includes(check.id) || !valid(check.question) || !valid(check.skill)) || new Set(policy.checks.map(check => check.id)).size !== policy.checks.length) throw new UsageError('Invalid turnChecks: use unique {id, question, skill} checks.');
  if (!Array.isArray(policy.rearmOn)) throw new UsageError('Invalid turnChecks.rearmOn: use tool rules with optional command, gh or script intent.');
  for (const rule of policy.rearmOn) {
    if (!rule || !valid(rule.tool) || ['command', 'gh', 'script', 'path'].some(key => rule[key] !== undefined && !valid(rule[key])) || rule.flags !== undefined && (!Array.isArray(rule.flags) || rule.flags.some(flag => !/^--[\w-]+$/.test(flag))) || Object.keys(rule).some(key => !['tool', 'command', 'gh', 'script', 'path', 'flags'].includes(key))) throw new UsageError('Invalid turnChecks.rearmOn rule.');
    try { for (const pattern of [rule.tool, rule.command, rule.script, rule.path].filter(Boolean)) new RegExp(pattern); } catch { throw new UsageError('Invalid turnChecks.rearmOn regular expression.'); }
  }
}
export const decisionFields = id => ({ requirements: ['changes', 'what'], feedback: ['applies', 'on', 'action'], frustration: ['applies', 'cause', 'prevention'] })[id] ?? ['applies', 'reason'];
export const toolName = event => typeof event.tool_name === 'string' ? event.tool_name.split(/[.:/]/).at(-1) : '';
export const toolCommand = event => typeof event.tool_input === 'string' ? event.tool_input : event.tool_input?.command ?? event.tool_input?.cmd ?? '';
export const modifyingTool = event => /^(write|edit|multiedit|apply_patch|(?:mcp__\w+__)?(?:write_file|write_text_file|append_file|edit_file|patch_file|create_file|delete_file|move_file))$/i.test(toolName(event));
const words = command => (command.match(/(?:[^\s"']+|"(?:\\.|[^"\\])*"|'[^']*')+/g) ?? []).map(word => word.replace(/"((?:\\.|[^"\\])*)"|'([^']*)'/g, (_, double, single) => double === undefined ? single : double.replace(/\\(["\\])/g, '$1')));
const valueFlags = new Set(['--repo', '-R', '--hostname', '--header', '-H', '--method', '-X', '--jq', '-q', '--template', '-t', '--field', '-F', '--raw-field', '-f', '--input', '--cache', '--preview', '-p', '--json', '--limit', '-L', '--branch', '-b', '--commit', '-c', '--job', '-j', '--body-file', '--body']);
export function commandArgs(command) {
  const tokens = words(command), executable = tokens.shift()?.split(/[\\/]/).at(-1)?.replace(/\.exe$/i, ''), positional = [], flags = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]; if (!token.startsWith('-')) { positional.push(token); continue; }
    const separator = token.indexOf('='), name = separator < 0 ? token : token.slice(0, separator);
    flags.set(name, separator >= 0 ? token.slice(separator + 1) : valueFlags.has(name) ? tokens[++i] : true);
  }
  return { executable, positional, flags };
}
export function reviewResult(event, policy) {
  const command = toolCommand(event), { executable, positional, flags } = commandArgs(command);
  if (words(command).some(token => ['--help', '-h'].includes(token))) return false;
  return policy.rearmOn.some(rule => {
    if (!new RegExp(rule.tool).test(toolName(event))) return false;
    if (!rule.gh && !rule.script) return !rule.command || new RegExp(rule.command).test(command);
    if (rule.script) return /^(python(?:3)?|py)$/.test(executable) && !flags.has('-c') && !flags.has('-m') && new RegExp(rule.script).test(positional[0] ?? '');
    const subcommand = rule.gh.split(' ');
    return executable === 'gh' && subcommand.every((word, i) => positional[i] === word) && (!rule.path || new RegExp(rule.path).test(positional[subcommand.length] ?? '')) && (!rule.flags || rule.flags.every(flag => flags.has(flag) && flags.get(flag) !== 'false'));
  });
}
export function turnMetrics(rows) {
  const edited = rows.filter(row => row.edited === true), delays = edited.filter(row => Number.isFinite(row.addedSeconds)).map(row => row.addedSeconds).sort((a, b) => a - b);
  const next = edited.map(row => rows.find(after => after.sessionId === row.sessionId && after.previousTurnId === row.turnId)); const classified = next.filter(row => typeof row?.userCorrection === 'boolean');
  return { editedTurns: edited.length, measuredTurns: delays.length, medianAddedSeconds: delays.length ? (delays[Math.floor((delays.length - 1) / 2)] + delays[Math.floor(delays.length / 2)]) / 2 : null, correctedNextMessage: classified.filter(row => row.userCorrection).length, classifiedNextMessages: classified.length, unclassifiedNextMessages: next.length - classified.length };
}
