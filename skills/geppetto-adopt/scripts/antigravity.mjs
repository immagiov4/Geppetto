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

const sessionStatePath = (root, sessionId) =>
  resolve(root, '.geppetto/hook-state', `ag-session-${digest(sessionId)}.json`);

async function readSessionState(root, sessionId) {
  if (!sessionId) return null;
  const state = await jsonFile(sessionStatePath(root, sessionId), null);
  return state && typeof state === 'object' && !Array.isArray(state) ? state : null;
}

async function writeSessionState(root, sessionId, update) {
  if (!sessionId) return;
  const path = sessionStatePath(root, sessionId);
  await withTurnLock(`${turnStatePath(root, sessionId)}.lock`, async () => {
    await ignoreLocalFiles(root, ['/hook-state/']);
    await mkdir(dirname(path), { recursive: true });
    const current = await jsonFile(path, {});
    const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
    await atomicJson(path, { ...base, ...update }, { mode: 0o600 });
  });
}

function fresherCursor(a, b) {
  if (!a) return b;
  if (!b) return a;
  return (b.offset ?? -1) > (a.offset ?? -1) ? b : a;
}

/** Translate Antigravity hook payloads and responses around Geppetto's core hook pipeline. */
export async function handleAntigravityEvent(normalized, options, runCore) {
  const phase = normalized.hook_event_name;
  const root = await projectRoot(normalized.cwd ?? '.');
  const sessionId = normalized.session_id;
  const adopted = Boolean(sessionId && await exists(resolve(root, '.geppetto/config.json')));

  if (phase === 'PreInvocation') {
    if (adopted) {
      const agState = await readSessionState(root, sessionId);
      const turnState = await readTurnState(root, sessionId);
      const cursor = fresherCursor(agState?.promptCursor, turnState?.promptCursor);
      let checkpoint = null;
      if (normalized.transcript_path) {
        try {
          checkpoint = await messageCheckpoint(resolve(normalized.cwd ?? root, normalized.transcript_path), cursor);
        } catch {
          checkpoint = null;
        }
      }
      const freshTurn = !agState || !agState.active || (!normalized.transcript_path && normalized.invocation_num === 0);
      const steering = !freshTurn && Boolean(checkpoint?.userMessage);
      if (freshTurn) {
        await drainPendingContext(root, sessionId);
        await runCore({ ...normalized, hook_event_name: 'UserPromptSubmit' }, options);
        const nextTurn = await readTurnState(root, sessionId);
        await writeSessionState(root, sessionId, {
          active: true,
          promptCursor: fresherCursor(checkpoint?.cursor ?? agState?.promptCursor, nextTurn?.promptCursor),
        });
      } else if (steering) {
        await runCore({ ...normalized, hook_event_name: 'UserPromptSubmit', steering: true }, options);
        const nextTurn = await readTurnState(root, sessionId);
        await writeSessionState(root, sessionId, {
          active: true,
          promptCursor: fresherCursor(checkpoint.cursor, nextTurn?.promptCursor),
        });
      } else if (checkpoint?.cursor && JSON.stringify(checkpoint.cursor) !== JSON.stringify(agState?.promptCursor)) {
        await writeSessionState(root, sessionId, { active: true, promptCursor: checkpoint.cursor });
      }
    }
    const queued = await drainPendingContext(root, sessionId);
    if (queued && adopted) {
      try {
        await logHookEvent(root, { hook: 'antigravityContext', status: 'delivered', injectedBytes: Buffer.byteLength(queued), modelCalls: 0 }, normalized);
      } catch (error) {
        console.error(`Geppetto antigravity context log diagnostic: ${String(error?.message ?? error).replace(/[\r\n]+/g, ' ')}`);
      }
    }
    return injectSystemMessage(queued);
  }

  if (phase === 'Stop' && normalized.termination_reason && normalized.termination_reason !== 'NO_TOOL_CALL') {
    await drainPendingContext(root, sessionId);
    if (adopted) {
      await writeSessionState(root, sessionId, { active: false });
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
    if (adopted) await writeSessionState(root, sessionId, { active: false });
    return {};
  }

  return {};
}
