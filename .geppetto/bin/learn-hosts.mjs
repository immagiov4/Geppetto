import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { delimiter, resolve, isAbsolute } from 'node:path';

/** Native subprocess protocols, not PID-based acknowledgement. Defaults never bypass permissions. */
export function cliLearningHost(name, { executable = name, prefix = [], model, sandbox = 'read-only', tools = [], boundary, provider, budgetControl, account, spawnProcess = spawn } = {}) {
  if (!['codex', 'claude'].includes(name)) throw new Error('Unsupported learning host');
  if (model !== undefined && (typeof model !== 'string' || !model.trim() || model.startsWith('-') || /[\r\n]/.test(model))) throw new Error('Learning model must be an explicitly selected model identifier');
  if (!['read-only', 'workspace-write'].includes(sandbox)) throw new Error('Learning cannot bypass the host sandbox');
  if (!Array.isArray(tools) || tools.some(tool => !['Read', 'Edit', 'Write', 'Glob', 'Grep'].includes(tool))) throw new Error('Learning tools must be explicitly narrowed; no shell or delegation');
  return { name, preflight(policy) {
    if (!boundary || boundary !== policy.boundary) return 'Host privacy/write boundary is unconfirmed';
    if (!provider || provider !== policy.provider) return 'Host provider routing has not been confirmed against the grant';
    if (!budgetControl) return 'Native host budget enforcement has not been verified against the maximum';
    const paths = isAbsolute(executable) ? [executable] : (process.env.PATH ?? '').split(delimiter).flatMap(dir => [resolve(dir, executable), resolve(dir, `${executable}.exe`)]);
    if (!paths.some(existsSync)) return 'Native host executable is unavailable; no reservation or launch made';
    return null;
  }, async submit(request, onAck) {
    if (!boundary || request.boundary !== boundary) throw new Error('Host privacy/write boundary has not been confirmed');
    const args = name === 'codex'
      ? ['exec', '--json', ...(request.provider ? ['--config', `model_provider=${JSON.stringify(request.provider)}`] : []), '--sandbox', request.phase === 'assessment' ? 'read-only' : sandbox, ...(model ? ['--model', model] : []), '-']
      : ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk', '--disallowedTools', 'mcp__*', '--tools', request.phase === 'assessment' ? '' : tools.join(','), ...(request.phase !== 'assessment' && tools.length ? ['--allowedTools', tools.join(',')] : []), '--max-budget-usd', request.maximumUsd, ...(model ? ['--model', model] : [])];
    const child = spawnProcess(executable, [...prefix, ...args], { cwd: request.root, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GEPPETTO_LEARNING_CHILD: '1' } });
    let processError;
    const closed = new Promise(resolve => { child.on('error', error => { processError = error; }); child.on('close', (code, signal) => resolve({ code, signal })); });
    // Never relay native diagnostics verbatim: they may contain credentials or host context.
    child.stderr.resume(); child.stdin.on('error', () => {}); child.stdin.end(request.prompt);
    let runId; let text; let terminal; let totalCost; let protocolError;
    try {
      for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        const identity = name === 'codex' && event.type === 'thread.started' ? event.thread_id : name === 'claude' && event.type === 'system' && event.subtype === 'init' ? event.session_id : undefined;
        if (identity !== undefined) {
          if (typeof identity !== 'string' || !identity || runId) throw new Error('Invalid or repeated native run acknowledgement');
          runId = identity; await onAck({ runId });
        }
        if (name === 'codex') {
          if (event.type === 'item.completed' && event.item?.type === 'agent_message') text = event.item.text;
          if (event.type === 'turn.completed') terminal = 'completed';
          if (['turn.failed', 'error'].includes(event.type)) terminal = 'failed';
          // Token usage is not a price. Codex JSONL has no authoritative USD total.
        } else if (event.type === 'result') {
          if (!runId || event.session_id !== runId) throw new Error('Claude result does not match init session');
          terminal = event.is_error || event.subtype !== 'success' ? 'failed' : 'completed'; text = event.result;
          if (Number.isFinite(event.total_cost_usd) && event.total_cost_usd >= 0) {
            // Round upward to the existing ledger's micro-dollar precision, never understate cost.
            totalCost = (Math.ceil(event.total_cost_usd * 1e6) / 1e6).toFixed(6);
          }
        }
      }
    } catch (error) { protocolError = error; child.kill(); }
    const exit = await closed;
    if (processError) throw new Error(`Host process unavailable (${processError.code ?? 'launch error'})`);
    if (protocolError) throw new Error('Invalid native host stream; reconcile any acknowledged run');
    if (!runId || !terminal || exit.signal) throw new Error('Native run ended without acknowledged terminal result');
    if (account) totalCost = await account(runId, { phase: request.phase, nativeCostUsd: totalCost });
    if (terminal === 'failed' || exit.code !== 0) return { ready: true, runId, failed: true, reason: 'Native host reported failure; inspect the authorized host session', costUsd: totalCost };
    let payload;
    try { payload = JSON.parse(text); }
    catch { return { ready: true, runId, failed: true, reason: 'Native run completed with invalid structured output', costUsd: totalCost }; }
    return { ready: true, runId, payload, costUsd: totalCost };
  } };
}

/** The Python plugin supplies the public ctx.subagent_lifecycle transport in an active turn. */
export function hermesLearningHost(transport) {
  if (typeof transport !== 'function') throw new Error('Hermes lifecycle transport unavailable');
  return { name: 'hermes', async preflight(policy) {
    const capability = await transport({ operation: 'capabilities' });
    if (!capability.available) return 'Public Hermes lifecycle unavailable in the active parent';
    if (capability.provider !== policy.provider || capability.boundary !== policy.boundary || !capability.budgetControl) return 'Hermes provider, privacy boundary or external budget control is unconfirmed';
    return null;
  }, async submit(request, ack) {
    const response = await transport({ operation: 'launch', request });
    if (typeof response?.runId !== 'string' || !response.runId) throw new Error('Hermes lifecycle did not return a child handle');
    await ack({ runId: response.runId });
    return response;
  }, poll: runId => transport({ operation: 'result', runId }), cancel: runId => transport({ operation: 'cancel', runId }) };
}
