import { UsageError } from './common.mjs';
import { readFileSync } from 'node:fs';
export const defaultTurnChecks = JSON.parse(readFileSync(new URL('./turn-checks.json', import.meta.url), 'utf8'));
export function turnPolicy(config) {
  const supplied = config.turnChecks; const policy = Array.isArray(supplied) ? { ...defaultTurnChecks, checks: supplied } : { ...defaultTurnChecks, ...supplied };
  const valid = text => typeof text === 'string' && text.trim() && !/[\r\n]/.test(text);
  const reserved = ['continuation', 'review', 'userCorrection', 'requestedAt', 'decidedAt', 'decisions', 'addedSeconds', 'edited', 'sessionId', 'turnId', 'previousTurnId', 'ts', 'transcriptOffset', '__proto__', 'constructor', 'prototype'];
  if (supplied !== undefined && !Array.isArray(supplied) && (!supplied || typeof supplied !== 'object' || Object.keys(supplied).some(key => !['checks', 'rearmOn'].includes(key))) || !Array.isArray(policy.checks) || policy.checks.some(check => !check || !/^[a-z][\w-]*$/.test(check.id) || reserved.includes(check.id) || !valid(check.question) || !valid(check.skill)) || new Set(policy.checks.map(check => check.id)).size !== policy.checks.length) throw new UsageError('Invalid turnChecks: use unique {id, question, skill} checks.');
  if (!Array.isArray(policy.rearmOn)) throw new UsageError('Invalid turnChecks.rearmOn: use {tool, command?} regex rules.');
  for (const rule of policy.rearmOn) {
    if (!rule || !valid(rule.tool) || rule.command !== undefined && !valid(rule.command) || Object.keys(rule).some(key => !['tool', 'command'].includes(key))) throw new UsageError('Invalid turnChecks.rearmOn rule.');
    try { for (const pattern of [rule.tool, rule.command].filter(Boolean)) new RegExp(pattern); } catch { throw new UsageError('Invalid turnChecks.rearmOn regular expression.'); }
  }
  return policy;
}
export const decisionFields = id => ({ requirements: ['changes', 'what'], feedback: ['applies', 'on', 'action'], frustration: ['applies', 'cause', 'prevention'] })[id] ?? ['applies', 'reason'];
export const toolName = event => typeof event.tool_name === 'string' ? event.tool_name.split(/[.:/]/).at(-1) : '';
export const toolCommand = event => typeof event.tool_input === 'string' ? event.tool_input : event.tool_input?.command ?? event.tool_input?.cmd ?? '';
/** Explicit shell forms only: arbitrary programs can also write files outside this classifier. */
export function modifyingTool(event) {
  if (/^(write|edit|multiedit|apply_patch)$/i.test(toolName(event))) return true;
  if (!/^(Bash|exec_command|shell_command|shell)$/.test(toolName(event))) return false;
  const command = toolCommand(event), bare = command.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '');
  return /(?:^|[;|&\r\n])\s*(?:Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item|Clear-Content|tee|touch|mkdir|rm|mv|cp|apply_patch)\b/i.test(bare) || /(?:^|[^<])>{1,2}(?!&)/.test(bare) || /\bsed\s+(?:[^;\r\n]*\s)?-i\b/.test(bare) || /^(?:node|python(?:3)?|py)\s+(?:-e|-c|--eval)\s/.test(bare) && /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|write_text|write_bytes|write\s*\()/.test(command);
}
export function turnMetrics(rows) {
  const edited = rows.filter(row => row.edited === true), delays = edited.filter(row => Number.isFinite(row.addedSeconds)).map(row => row.addedSeconds).sort((a, b) => a - b);
  const next = edited.map(row => rows.find(after => after.sessionId === row.sessionId && after.previousTurnId === row.turnId)); const classified = next.filter(row => typeof row?.userCorrection === 'boolean');
  return { editedTurns: edited.length, measuredTurns: delays.length, medianAddedSeconds: delays.length ? (delays[Math.floor((delays.length - 1) / 2)] + delays[Math.floor(delays.length / 2)]) / 2 : null, correctedNextMessage: classified.filter(row => row.userCorrection).length, classifiedNextMessages: classified.length, unclassifiedNextMessages: next.length - classified.length };
}
