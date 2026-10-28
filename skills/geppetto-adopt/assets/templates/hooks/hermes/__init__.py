"""Native Hermes adapter for the upstream Geppetto memory and learn-nudge hooks."""
import json
from pathlib import Path
import subprocess
import threading

_CTX = None
_CHILD_SESSIONS = set()

_SETTINGS = json.loads(Path(__file__).with_name('settings.json').read_text(encoding='utf-8'))
_LOCK = threading.RLock()


def _run(payload):
    from hermes_cli.plugins import _resolve_hook_callback_timeout
    timeout = _resolve_hook_callback_timeout()
    with _LOCK:
        proc = subprocess.run(
            [_SETTINGS['node'], str(Path(__file__).with_name('bridge.mjs'))],
            input=json.dumps({**payload, 'projectRoot': _SETTINGS['projectRoot']}),
            capture_output=True, text=True, encoding='utf-8',
            cwd=_SETTINGS['projectRoot'], check=True,
            timeout=timeout if timeout > 0 else None,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
    return json.loads(proc.stdout)


def _reminder(reason):
    if not reason:
        return ''
    command = f'"{_SETTINGS["node"]}" "{_SETTINGS["scripts"]}/signal.mjs"'
    return ('Geppetto learning reminder: al termine del compito e prima della risposta finale, '
            'valuta se il lavoro ha evidenziato attriti o lezioni riutilizzabili '
            'con la skill geppetto/geppetto-learn. '
            'Registra un segnale solo se utile; preserva il perimetro e le autorizzazioni. '
            f'Per il segnale usa {command} "<attrito>" --key <chiave> --session <sessione> --category <categoria> '
            f'--scope hermes-default dalla cartella {_SETTINGS["projectRoot"]}. '
            'Usa --list per le sole chiavi aperte e --evidence <riferimento> per other; '
            'non inventare provenienza o indipendenza.')


def before_turn(session_id='', turn_id='', parent_session_id='', **_):
    if not session_id or session_id in _CHILD_SESSIONS:
        return None
    result = _run({'phase': 'begin', 'session_id': session_id, 'turn_id': turn_id})
    parts = [part for part in (result['memory'], _reminder(result['learning'])) if part]
    return {'context': '\n\n'.join(parts)} if parts else None


def after_tool(result=None, session_id='', turn_id='', tool_call_id='', duration_ms=0, **_):
    if not session_id or not tool_call_id or session_id in _CHILD_SESSIONS:
        return None
    parsed = None
    plain = False
    if isinstance(result, str):
        try:
            parsed = json.loads(result)
        except ValueError:
            plain = True
    can_remind = isinstance(parsed, dict) or plain
    response = _run({'phase': 'tool', 'session_id': session_id, 'turn_id': turn_id,
                     'tool_call_id': tool_call_id, 'duration_ms': duration_ms,
                     'can_remind': can_remind})
    reminder = _reminder(response['learning'])
    if not reminder:
        return None
    if isinstance(parsed, dict):
        parsed['_geppetto_learning_reminder'] = reminder
        return json.dumps(parsed, ensure_ascii=False)
    return result + '\n\n' + reminder


def register(ctx):
    global _CTX
    _CTX = ctx
    ctx.register_hook('pre_llm_call', before_turn)
    ctx.register_hook('transform_tool_result', after_tool)
