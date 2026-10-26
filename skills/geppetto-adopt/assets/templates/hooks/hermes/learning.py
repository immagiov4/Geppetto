"""Hermes public lifecycle adapter. No thread, scheduler, transcript or provider access.

The plugin caller supplies ctx and invokes advance while its parent turn is active.
Handles remain in-process and are never written into project evidence.
"""
import json
import hashlib
import os
from pathlib import Path
import subprocess


class LearningLifecycle:
    def __init__(self, account=None):
        self.handles = {}
        self.goal_hashes = set()
        # A trusted external accounting adapter may supply authoritative USD.
        # API-call counts in Hermes usage_metadata are NOT prices.
        self.account = account

    def dispatch(self, service, message, settings, session_id):
        operation = message['operation']
        if operation == 'capabilities':
            return {'available': service is not None, 'provider': settings.get('learningProvider'),
                    'boundary': settings.get('learningBoundary'), 'budgetControl': settings.get('learningBudgetControl')}
        if operation == 'launch':
            request = message['request']
            from agent.subagent_lifecycle import SubagentLaunchRequest
            toolsets = () if request['phase'] == 'assessment' else tuple(settings.get('learningToolsets', ()))
            # working_directory and per-launch timeout are rejected by the public API.
            # Parent scope must already enforce the operator-approved boundary.
            self.goal_hashes.add(hashlib.sha256(request['prompt'].encode()).hexdigest())
            handle = service.launch(SubagentLaunchRequest(
                goal=request['prompt'], role='leaf', allowed_toolsets=toolsets,
                correlation_id=request['id'], parent_session_id=session_id,
                provider=request.get('provider'),
            ))
            self.handles[handle.subagent_id] = handle
            return {'runId': handle.subagent_id, 'ready': False}
        run_id = message['runId']
        handle = self.handles.get(run_id)
        if handle is None:
            return {'error': 'Hermes handle unavailable after restart or in another session; reconcile without relaunch'}
        if operation == 'cancel':
            result = service.cancel(handle, reason='Owner requested cancellation of scoped learning')
            return {'accepted': result.accepted, 'state': result.state.value}
        if operation != 'result':
            return {'error': 'Unsupported lifecycle operation'}
        result = service.result(handle)
        if not result.ready:
            return {'runId': run_id, 'ready': False}
        response = {'runId': run_id, 'ready': True}
        state = result.terminal_state.value
        if state == 'SUCCEEDED':
            try:
                response['payload'] = result.structured_payload or json.loads(result.summary)
            except (TypeError, ValueError):
                response.update(failed=True, reason='Hermes completed with invalid structured output')
        else:
            response.update(failed=True, reason=f'Hermes terminal state {state}')
        if self.account is not None:
            cost = self.account(handle, result)
            if cost is not None:
                response['costUsd'] = cost
        return response

    def advance(self, ctx, settings, session_id):
        if not session_id or os.environ.get('GEPPETTO_LEARNING_CHILD') == '1':
            return None
        service = getattr(ctx, 'subagent_lifecycle', None)
        # No fallback to internal AIAgent/delegate_tool or a detached Hermes CLI.
        script = str(Path(settings['scripts']) / 'learn-host.mjs')
        proc = subprocess.Popen(
            [settings['node'], script, '--hermes-rpc', '--project', settings['projectRoot']],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8', cwd=settings['projectRoot'],
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
        final = None
        try:
            for line in proc.stdout:
                record = json.loads(line)
                if 'done' in record:
                    final = record['done']
                    break
                if 'rpc' not in record:
                    raise ValueError('Unexpected learning bridge response')
                try:
                    reply = self.dispatch(service, record['rpc'], settings, session_id) if service is not None or record['rpc'].get('operation') == 'capabilities' else {'error': 'Public Hermes subagent lifecycle unavailable in this runtime'}
                except Exception:
                    # Technical errors may contain host context. The state retains a stable diagnostic.
                    reply = {'error': 'Hermes lifecycle operation failed; inspect the acknowledged session before retrying'}
                proc.stdin.write(json.dumps(reply) + '\n')
                proc.stdin.flush()
            proc.stdin.close()
            proc.wait()
            if proc.returncode != 0:
                raise RuntimeError('Learning bridge failed; reconcile its project state before retrying')
            return final
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
            proc.stdout.close()
            proc.stderr.close()
