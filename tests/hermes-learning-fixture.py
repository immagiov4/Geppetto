"""Provider-free native Hermes contract fixture, never imports a live agent."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
from dataclasses import dataclass
from enum import Enum
from types import SimpleNamespace


class State(Enum):
    SUCCEEDED = 'SUCCEEDED'
    CANCEL_REQUESTED = 'CANCEL_REQUESTED'


@dataclass
class Request:
    goal: str
    role: str = 'leaf'
    allowed_toolsets: tuple = ()
    correlation_id: str | None = None
    parent_session_id: str | None = None
    provider: str | None = None


# A test double of the documented public module, not a substitute for a live runtime check.
agent = types.ModuleType('agent')
lifecycle = types.ModuleType('agent.subagent_lifecycle')
lifecycle.SubagentLaunchRequest = Request
sys.modules['agent'] = agent
sys.modules['agent.subagent_lifecycle'] = lifecycle
plugins = types.ModuleType('hermes_cli.plugins')
plugins._resolve_hook_callback_timeout = lambda: 30
sys.modules['hermes_cli'] = types.ModuleType('hermes_cli')
sys.modules['hermes_cli.plugins'] = plugins


class Service:
    def __init__(self, root, callbacks):
        self.root = root
        self.callbacks = callbacks
        self.runs = {}
        self.requests = []

    def launch(self, request):
        assert request.role == 'leaf'
        assert request.parent_session_id == 'parent-fixture'
        assert request.provider == 'synthetic'
        assert request.allowed_toolsets == ()
        self.requests.append(request)
        child_id = f'fixture-child-{len(self.requests)}'
        self.callbacks['subagent_start'](child_session_id=child_id, child_goal=request.goal)
        if 'UNTRUSTED_PROJECT_SIGNALS=' in request.goal:
            payload = {
                'disposition': 'recurring', 'cause': 'Working directory omitted at child launch',
                'rationale': 'Independent builds hit the same launcher boundary.',
                'alternatives': 'The input files exist in both builds.',
                'cluster': None, 'comparisons': [],
                'evidence': [{'signalId': r['id'], 'episode': r['episode'], 'source': r['source'], 'support': 'Separate identified build with its own resolved path.'} for r in map(json.loads, (self.root / '.geppetto/signals.jsonl').read_text().splitlines())],
            }
        else:
            before = json.loads((self.root / 'owner.json').read_text())
            assert before == {'passWorkingDirectory': False}
            (self.root / 'owner.json').write_text(json.dumps({'passWorkingDirectory': True}))
            assert json.loads((self.root / 'owner.json').read_text())['passWorkingDirectory'] is True
            (self.root / 'measurement.json').write_text(json.dumps({'baseline': False, 'treatment': True, 'verified': True}))
            payload = {'disposition': 'keep', 'owner': 'owner.json', 'rationale': 'Verified working-directory correction', 'evidence': ['measurement.json#baseline', 'measurement.json#treatment', 'measurement.json#verified'], 'limitations': ['Synthetic Hermes service; no provider or live runtime used']}
        handle = SimpleNamespace(subagent_id=child_id)
        self.runs[child_id] = SimpleNamespace(ready=True, terminal_state=State.SUCCEEDED, structured_payload=None, summary=json.dumps(payload), usage_metadata={'api_calls': 0})
        return handle

    def result(self, handle):
        return self.runs[handle.subagent_id]

    def cancel(self, handle, reason):
        assert reason
        return SimpleNamespace(accepted=True, state=State.CANCEL_REQUESTED)


def main():
    repo = Path(__file__).resolve().parents[1]
    source = repo / 'skills/geppetto-adopt/assets/templates/hooks/hermes'
    node = sys.argv[1]
    with tempfile.TemporaryDirectory(prefix='geppetto-hermes-') as temporary:
        root = Path(temporary)
        home = root / 'home'
        home.mkdir()
        os.environ['HOME'] = str(home)
        os.environ['USERPROFILE'] = str(home)
        project = root / 'project'
        (project / '.geppetto').mkdir(parents=True)
        policy = {'enabled': True, 'benchmark': None, 'provider': 'synthetic', 'boundary': 'fixture-only', 'assessmentMaxUsd': '0', 'investigationMaxUsd': '0'}
        (project / '.geppetto/config.json').write_text(json.dumps({'hooks': {'signalLearning': policy, 'learnNudge': {'minToolCalls': 1}}}))
        records = [{'id': x, 'ts': '2026-10-26', 'kind': 'friction', 'scope': 'project', 'metric': 'reliability', 'text': 'Child cwd omitted' if x == 'a' else 'Inputs resolved in home', 'episode': f'run-{x}', 'source': f'fixture:{x}'} for x in ('a', 'b')]
        for record in records:
            subprocess.run([node, str(repo / 'skills/geppetto-adopt/scripts/signal.mjs'), record['text'], '--metric', record['metric'], '--episode', record['episode'], '--source', record['source']], cwd=project, check=True, capture_output=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        grants = ''.join(f'[{cap}] provider=synthetic budget_usd=0 per=30d scope="fixture-only" expires=2099-12-31\n' for cap in ('signal-assessment', 'signal-investigation'))
        (home / '.geppetto').mkdir()
        (home / '.geppetto/authorizations').write_text(grants)
        (project / '.geppetto/authorizations').write_text(grants)
        (project / 'owner.json').write_text(json.dumps({'passWorkingDirectory': False}))
        plugin = root / 'candidate'
        plugin.mkdir()
        for name in ('__init__.py', 'learning.py', 'bridge.mjs'):
            shutil.copyfile(source / name, plugin / name)
        settings = {'node': node, 'scripts': str(repo / 'skills/geppetto-adopt/scripts'), 'projectRoot': str(project), 'learningToolsets': [], 'learningProvider': 'synthetic', 'learningBoundary': 'fixture-only', 'learningBudgetControl': 'fixture:no-provider'}
        (plugin / 'settings.json').write_text(json.dumps(settings))
        spec = importlib.util.spec_from_file_location('fixture_hooks', plugin / '__init__.py', submodule_search_locations=[str(plugin)])
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        callbacks = {}
        service = Service(project, callbacks)
        ctx = SimpleNamespace(subagent_lifecycle=service, register_hook=lambda name, callback: callbacks.__setitem__(name, callback))
        module.register(ctx)
        module._LEARNING.account = lambda _handle, _result: '0'  # Known provider-free test execution, not a production cost inference.
        callbacks['pre_llm_call'](session_id='parent-fixture', turn_id='turn-a')
        transformed = callbacks['transform_tool_result'](session_id='parent-fixture', turn_id='turn-a', tool_call_id='call-a', result='{}')
        assert '_geppetto_learning_reminder' in json.loads(transformed)
        next_context = callbacks['pre_llm_call'](session_id='parent-fixture', turn_id='turn-b')
        assert next_context is None or 'Geppetto learning reminder:' not in next_context['context'], 'an already delivered native turn must not be recovered again'
        state = json.loads((project / '.geppetto/learning/state.json').read_text())
        assert state['status'] == 'keep', state
        assert len(service.requests) == 2
        assert state['attempts'][1]['runId'] == 'fixture-child-2'
        assert json.loads((project / 'measurement.json').read_text()) == {'baseline': False, 'treatment': True, 'verified': True}
        later = callbacks['transform_tool_result'](session_id='parent-fixture', turn_id='turn-b', tool_call_id='call-b', result='{}')
        assert '_geppetto_learning_reminder' in json.loads(later)
        assert callbacks['transform_tool_result'](session_id='parent-fixture', turn_id='turn-b', tool_call_id='call-b-duplicate', result='{}') is None
        # Tool-result representations that cannot carry a reminder defer it to internal context.
        quiet_config = {'hooks': {'signalLearning': {'enabled': False}, 'learnNudge': {'minToolCalls': 1}}}
        (project / '.geppetto/config.json').write_text(json.dumps(quiet_config))
        plain = callbacks['transform_tool_result'](session_id='plain-fixture', turn_id='plain', tool_call_id='plain-call', result='tool output')
        assert plain.startswith('tool output\n\nGeppetto learning reminder:')
        assert callbacks['transform_tool_result'](session_id='deferred-fixture', turn_id='first', tool_call_id='array-call', result='[]') is None
        deferred = callbacks['pre_llm_call'](session_id='deferred-fixture', turn_id='second')
        assert 'Geppetto learning reminder:' in deferred['context']
        repeated = callbacks['pre_llm_call'](session_id='deferred-fixture', turn_id='third')
        assert repeated is None or 'Geppetto learning reminder:' not in repeated['context']
        for call_id in ('missing-turn-first', 'missing-turn-second'):
            callbacks['pre_llm_call'](session_id='missing-turn-fixture')
            without_turn = callbacks['transform_tool_result'](session_id='missing-turn-fixture', tool_call_id=call_id, result='{}')
            assert '_geppetto_learning_reminder' in json.loads(without_turn), 'missing native turn IDs must use each prompt boundary'
        # Native child callbacks do not recursively assess their own work.
        original_bridge = module._run
        module._run = lambda _payload: (_ for _ in ()).throw(AssertionError('Learning child must not read memory or fire a nudge'))
        assert callbacks['pre_llm_call'](session_id='fixture-child-2', parent_session_id='parent-fixture') is None
        callbacks['transform_tool_result'](session_id='fixture-child-2', turn_id='child-turn', tool_call_id='child-call', result='{}')
        module._run = original_bridge
        assert len(service.requests) == 2
        adapter = module._LEARNING
        assert adapter.dispatch(service, {'operation': 'cancel', 'runId': 'fixture-child-2'}, settings, 'parent-fixture')['state'] == 'CANCEL_REQUESTED'
        assert 'error' in type(adapter)().dispatch(service, {'operation': 'result', 'runId': 'fixture-child-2'}, settings, 'parent-fixture')
        # Actual native API omits USD: remove the accounting fixture and prove the unknown is preserved.
        assert 'costUsd' not in type(adapter)().dispatch(service, {'operation': 'launch', 'request': {'phase': 'assessment', 'id': 'cost-only', 'prompt': 'UNTRUSTED_PROJECT_SIGNALS=', 'provider': 'synthetic'}}, settings, 'parent-fixture')
        print(json.dumps({'result': 'PASS', 'nativeDoubleLaunchesForEndToEnd': 2, 'status': state['status'], 'callbacks': sorted(callbacks), 'cost': 'explicit synthetic zero only; native unknown preserved', 'scope': 'temporary fixture only'}))


if __name__ == '__main__':
    main()
