import { createHash } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { atomicJson, exists, ignoreLocalFiles, jsonFile, projectRoot } from './common.mjs';
import { logHookEvent } from './hook-events.mjs';
import { messageCheckpoint, readTurnState, turnStatePath, withTurnLock } from './turn-messages.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');

export function isAntigravityEvent(event, harness) {
  return harness === 'antigravity' || Boolean(event && typeof event === 'object' &&
    (typeof event.hookEventName === 'string' || typeof event.conversationId === 'string'));
}

function normalizeToolInput(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const input = { ...args };
  if (typeof args.CommandLine === 'string' && input.command === undefined) input.command = args.CommandLine;
  if (typeof args.Path === 'string' && input.file_path === undefined) input.file_path = args.Path;
  if (typeof args.IsDaemon === 'boolean' && input.run_in_background === undefined) input.run_in_background = args.IsDaemon;
  return input;
}

export function normalizeAntigravityEvent(event) {
  if (!event || typeof event !== 'object') return event;
  const hookEventName = event.hookEventName ?? event.hook_event_name;
  const cwd = event.cwd ?? (Array.isArray(event.workspacePaths) ? event.workspacePaths[0] : undefined);
  const toolCall = event.toolCall && typeof event.toolCall === 'object' ? event.toolCall : null;
  const normalized = {
    ...event,
    harness: 'antigravity',
    hook_event_name: hookEventName,
    session_id: event.conversationId ?? event.session_id,
    cwd,
    ...(event.transcriptPath !== undefined && { transcript_path: event.transcriptPath }),
    ...(event.lastUserInput !== undefined && { prompt: event.lastUserInput }),
    ...(typeof event.continuationActive === 'boolean' && { stop_hook_active: event.continuationActive }),
    ...(typeof event.terminationReason === 'string' && { termination_reason: event.terminationReason }),
    ...(typeof event.invocationNum === 'number' && { invocation_num: event.invocationNum }),
  };
  if (toolCall) {
    if (toolCall.id !== undefined) normalized.tool_use_id = toolCall.id;
    if (toolCall.name !== undefined) normalized.tool_name = toolCall.name;
    normalized.tool_input = normalizeToolInput(toolCall.args ?? {});
  }
  if (typeof event.error === 'string' && event.error.trim()) normalized.tool_error = event.error;
  return normalized;
}

const pendingContextPath = (root, sessionId) =>
  resolve(root, '.geppetto/hook-state', `ag-context-${digest(sessionId)}.json`);

async function queuePendingContext(root, sessionId, text) {
  if (!sessionId || typeof text !== 'string' || !text.trim()) return;
  const path = pendingContextPath(root, sessionId);
  await withTurnLock(`${turnStatePath(root, sessionId)}.lock`, async () => {
    await ignoreLocalFiles(root, ['/hook-state/']);
    await mkdir(dirname(path), { recursive: true });
    const current = await jsonFile(path, []);
    const items = Array.isArray(current) ? current.filter(item => typeof item === 'string' && item.trim()) : [];
    if (!items.includes(text)) items.push(text);
    await atomicJson(path, items, { mode: 0o600 });
  });
}

async function drainPendingContext(root, sessionId) {
  if (!sessionId) return '';
  const path = pendingContextPath(root, sessionId);
  if (!await exists(path)) return '';
  return withTurnLock(`${turnStatePath(root, sessionId)}.lock`, async () => {
    if (!await exists(path)) return '';
    const current = await jsonFile(path, []);
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return (Array.isArray(current) ? current : []).filter(item => typeof item === 'string' && item.trim()).join('\n\n');
  });
}

const injectSystemMessage = text => text ? { injectSteps: [{ systemMessage: { systemMessage: text } }] } : {};

async function shouldStartTurnOnPreInvocation(root, event) {
  if (!event.session_id || !await exists(resolve(root, '.geppetto/config.json'))) return false;
  const state = await readTurnState(root, event.session_id);
  if (!state) return true;
  if (event.transcript_path) {
    try {
      const checkpoint = await messageCheckpoint(resolve(event.cwd ?? root, event.transcript_path), state.promptCursor);
      return Boolean(checkpoint.userMessage);
    } catch {
      return event.invocation_num === 1;
    }
  }
  return event.invocation_num === 1;
}

/** Translate Antigravity hook payloads and responses around Geppetto's core hook pipeline. */
export async function handleAntigravityEvent(normalized, options, runCore) {
  const phase = normalized.hook_event_name;
  const root = await projectRoot(normalized.cwd ?? '.');
  const sessionId = normalized.session_id;

  if (phase === 'PreInvocation') {
    if (await shouldStartTurnOnPreInvocation(root, normalized)) {
      await runCore({ ...normalized, hook_event_name: 'UserPromptSubmit' }, options);
    }
    const queued = await drainPendingContext(root, sessionId);
    if (queued && await exists(resolve(root, '.geppetto/config.json'))) {
      await logHookEvent(root, { hook: 'antigravityContext', status: 'delivered', injectedBytes: Buffer.byteLength(queued), modelCalls: 0 }, normalized);
    }
    return injectSystemMessage(queued);
  }

  if (phase === 'Stop' && normalized.termination_reason && normalized.termination_reason !== 'NO_TOOL_CALL') {
    if (sessionId && await exists(resolve(root, '.geppetto/config.json'))) {
      await logHookEvent(root, { hook: 'antigravityStop', status: 'skipped', reason: normalized.termination_reason, modelCalls: 0 }, normalized);
    }
    return {};
  }

  const result = await runCore(normalized, options) ?? {};

  if (phase === 'SessionStart') {
    return injectSystemMessage(result.hookSpecificOutput?.additionalContext ?? '');
  }

  if (phase === 'PreToolUse') {
    if (result.hookSpecificOutput?.permissionDecision === 'deny') {
      return {
        decision: 'deny',
        reason: result.hookSpecificOutput.permissionDecisionReason ?? 'Blocked by Geppetto.',
      };
    }
    if (result.hookSpecificOutput?.additionalContext) {
      await queuePendingContext(root, sessionId, result.hookSpecificOutput.additionalContext);
    }
    // Antigravity PreToolUse requires an explicit decision; omitting it fails closed as deny.
    return { decision: 'allow' };
  }

  if (phase === 'PostToolUse') {
    if (result.hookSpecificOutput?.additionalContext) {
      await queuePendingContext(root, sessionId, result.hookSpecificOutput.additionalContext);
    }
    return {};
  }

  if (phase === 'Stop') {
    if (result.decision === 'block') {
      return {
        decision: 'continue',
        reason: result.reason ?? 'Complete the pending Geppetto check before finishing.',
      };
    }
    return {};
  }

  return {};
}
