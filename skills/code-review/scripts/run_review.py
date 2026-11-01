"""Serial local review with independent sessions and verifiable evidence."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

MODEL = "gpt-6.1-sol"
ROOT = Path(__file__).resolve().parents[1]
REQUIRED = ("before", "after", "diff.patch", "contract.md", "manifest.json")
MAX_QUESTIONS = 20


def require(condition, message):
    if not condition:
        raise ValueError(message)


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def fingerprint(case):
    result = {}
    for path in sorted(case.rglob("*")):
        require(not path.is_symlink(), f"Symlink in case: {path.name}")
        require(path.resolve().is_relative_to(case), "Path outside case")
        if path.is_file():
            result[path.relative_to(case).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def unchanged(case, frozen):
    require(fingerprint(case) == frozen, "Case contents changed")


def changed_paths(case):
    before = {p.relative_to(case / "before").as_posix(): p.read_bytes()
              for p in (case / "before").rglob("*") if p.is_file()}
    after = {p.relative_to(case / "after").as_posix(): p.read_bytes()
             for p in (case / "after").rglob("*") if p.is_file()}
    return sorted(p for p in before.keys() | after.keys() if before.get(p) != after.get(p))


def validate(value, schema):
    """Validate the JSON Schema subset used by responses."""
    kind = schema["type"]
    expected = {"object": dict, "array": list, "string": str, "integer": int}[kind]
    require(type(value) is expected, f"Expected JSON type: {kind}")
    if "enum" in schema:
        require(value in schema["enum"], "Value outside enumeration")
    if kind == "object":
        require(set(value) == set(schema["required"]), "Missing or extra JSON fields")
        for name, child in value.items():
            validate(child, schema["properties"][name])
    elif kind == "array":
        for child in value:
            validate(child, schema["items"])
    elif kind == "string":
        require(bool(value.strip()), "Empty text")
    else:
        require(value >= schema.get("minimum", 0), "Number outside range")


def location(case, finding):
    path = question_source(case, finding["file"])
    side = "after" if path.is_relative_to(case / "after") else "before"
    lines = len(path.read_text(encoding="utf-8").splitlines())
    require(1 <= finding["line_start"] <= finding["line_end"] <= lines,
            "Finding range outside source")
    return side


def validate_search(case, response, changed, schema):
    validate(response, schema)
    ids = [finding["id"] for finding in response["findings"]]
    require(len(ids) == len(set(ids)), "Duplicate identifiers")
    for finding in response["findings"]:
        location(case, finding)
    covered = [entry["file"] for entry in response["coverage"]]
    require(len(covered) == len(set(covered)) and set(covered) == set(changed),
            "Coverage differs from changed paths")
    for entry in response["coverage"]:
        require(bool(entry["aspects"]), "Coverage without examined aspects")


def effective_context(thread_id, model, effort):
    require(isinstance(thread_id, str) and thread_id and
            all(c.isalnum() or c == "-" for c in thread_id), "Invalid session identifier")
    sessions = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "sessions"
    contexts = []
    for path in sessions.rglob(f"*{thread_id}*.jsonl"):
        with path.open(encoding="utf-8") as stream:
            for line in stream:
                record = json.loads(line)
                if record.get("type") == "turn_context":
                    payload = record["payload"]
                    require(payload.get("approval_policy") == "never", "Effective approval policy differs")
                    contexts.append({"model": payload.get("model"),
                                     "effort": payload.get("effort", payload.get("reasoning_effort")),
                                     "sandbox": payload.get("sandbox_policy")})
    require(bool(contexts), "Missing effective session context")
    for context in contexts:
        check_model(context, model, effort)
        require(isinstance(context["sandbox"], dict) and
                context["sandbox"].get("type") == "read-only", "Effective protection differs from read-only")
    # The record retains only the protection type, never the full session contents.
    return {"model": model, "effort": effort, "sandbox": "read-only"}


def check_model(context, model, effort):
    require(context["model"] == model and context["effort"] == effort,
            "Effective model or effort differs from requested settings")


def check_completion(exit_code, events):
    require(exit_code == 0, f"Codex exited with code {exit_code}")
    require(not any(e.get("type") in ("error", "turn.failed") for e in events),
            "Codex session failed")
    completed = [e for e in events if e.get("type") == "turn.completed"]
    require(len(completed) == 1 and isinstance(completed[0].get("usage"), dict),
            "Missing session completion or usage")
    return completed[0]["usage"]


def run_call(args, frozen, label, prompt, schema_path, metrics):
    unchanged(args.case, frozen)
    prompt += f"\nBudget: up to {getattr(args, 'tool_budget', 24)} effective tool calls and {args.timeout_seconds:g} seconds per session. Tool count is an instructed limit.\n"
    (args.output / f"{label}.prompt.txt").write_text(prompt, encoding="utf-8")
    response_path = args.output / f"{label}.json"
    command = [args.codex, "--no-daemon", "-a", "never",
               "-c", 'windows.sandbox="unelevated"', "-c", f"review_model={json.dumps(args.model)}",
               "-c", f"model_reasoning_effort={json.dumps(args.effort)}", "exec", "--ignore-user-config", "-m", args.model,
               "--sandbox", "read-only", "--skip-git-repo-check", "--json",
               "--output-schema", str(schema_path), "-o", str(response_path), "-"]
    started = time.monotonic()
    record = {"stage": label, "requested_model": args.model, "requested_effort": args.effort,
              "started_at": time.time(), "status": "running",
              "prompt_sha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
              "exit_code": None, "elapsed_seconds": None, "usage": None, "effective": None}
    metrics["calls"].append(record)
    save(args.output / "metrics.json", metrics)
    process = subprocess.Popen(command, cwd=args.case, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               encoding="utf-8", errors="strict",
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    try:
        stdout, stderr = process.communicate(prompt, timeout=args.timeout_seconds)
    except subprocess.TimeoutExpired:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        process.kill()
        stdout, stderr = process.communicate()
        record["timed_out"] = True
    finally:
        record["elapsed_seconds"] = round(time.monotonic() - started, 3)
        record["exit_code"] = process.returncode
        unchanged(args.case, frozen)
    (args.output / f"{label}.events.jsonl").write_text(stdout, encoding="utf-8")
    # stderr may contain account details: record only its presence in the report.
    record["stderr_present"] = bool(stderr)
    require(not record.get("timed_out"), "Session time limit reached")
    events = [json.loads(line) for line in stdout.splitlines() if line.strip()]
    record["usage"] = check_completion(process.returncode, events)
    threads = [e.get("thread_id") for e in events if e.get("type") == "thread.started"]
    require(len(threads) == 1, "Independent session not identified")
    require(threads[0] not in metrics["thread_ids"], "Session context reused")
    metrics["thread_ids"].append(threads[0])
    record["effective"] = effective_context(threads[0], args.model, args.effort)
    data = response_path.read_bytes()
    record["response_sha256"] = hashlib.sha256(data).hexdigest()
    record["status"] = "returned"
    save(args.output / "metrics.json", metrics)
    return json.loads(data)


def prompt_base(case, changed, questions=False):
    common = f"""Perform a local read-only audit in English of this case: {case}.
Read only before/, after/, diff.patch, contract.md, manifest.json and AGENTS.md files included in the case.
The contract defines intended behaviour. Respect applicable instructions
and authorized decisions recorded in the contract; retain unresolved conflicts in limitations.
Use case reads only: no network, accounts, configuration, builds, tests,
tool writes or delegation. Return only the requested JSON.
Changed paths: {json.dumps(changed)}.
"""
    if questions:
        return common + f"""Generate up to {MAX_QUESTIONS} concrete questions from the changed source and relevant consumers, without padding or asserting bugs.
Each question has a unique ID, a file relative to the source root and a line (after/, or before/ for a deleted file).
Use file 'route.js', never 'after/route.js' or 'before/route.js'. Also provide
an observed source fact, an investigable question, needed evidence and the relationship examined.
Return questions and limitations only. Do not include proposed findings or historical reviewer reports.
"""
    return common + """
Every finding describes a concrete defect with cause, triggering condition,
consequence and evidence in source and diff. Use the path relative to after/
and actual after/ lines. If a file was deleted and is absent from after/, use lines
from the existing before/ file and state in the evidence that they refer to before/.
Cover every changed path once, with examined aspects and specific evidence.
Distinguish defects from preferences; record static-inspection limitations.
"""


def question_source(case, relative):
    path = Path(relative)
    require(not path.is_absolute() and path.as_posix() == relative and ".." not in path.parts,
            "Invalid question source path")
    side = "after" if (case / "after" / path).exists() else "before"
    source = case / side / path
    require(source.resolve().is_relative_to(case / side) and source.is_file(), "Missing question source")
    return source


def validate_questions(case, response, schema):
    validate(response, schema)
    questions = response["questions"]
    require(len(questions) <= MAX_QUESTIONS, f"More than {MAX_QUESTIONS} questions")
    ids = [question["id"] for question in questions]
    require(len(ids) == len(set(ids)), "Duplicate question identifiers")
    for question in questions:
        source = question_source(case, question["file"])
        require(1 <= question["line"] <= len(source.read_text(encoding="utf-8").splitlines()),
                "Question line outside source")
    return questions


def validate_triage(case, triage, questions, schema):
    validate(triage, schema)
    entries = triage["questions"]
    ids = [entry["id"] for entry in entries]
    require(len(ids) == len(set(ids)) and set(ids) == {question["id"] for question in questions},
            "Incomplete, duplicate or unrelated question accounting")
    for entry in entries:
        for source in entry["checked_sources"]:
            question_source(case, source)
        if entry["status"] in ("no_issue", "reported"):
            require(entry["checked_sources"] and entry["last_consumer"].strip().lower() != "none",
                    "Closed question without checked consumer")


def question_discovery(args, frozen, changed, schemas, metrics):
    questions_response = run_call(args, frozen, "questions", prompt_base(args.case, changed, questions=True),
                                  ROOT / "references/questions.schema.json", metrics)
    questions = validate_questions(args.case, questions_response, schemas["questions"])
    metrics["calls"][-1]["status"] = "completed"
    metrics["question_count"] = len(questions)
    prompt = prompt_base(args.case, changed) + """
Investigate the supplied questions alongside the ordinary review brief. They are leads, not proof.
For each question you investigate, follow the relevant value, error or readiness condition through
handoffs to its effective consumer or observable outcome. A forwarding service passing a value
intact is not sufficient to close a downstream-behavior question. For potential regressions,
compare a concrete previously successful path with the target, including reuse/fast-return branches.
Record the last checked consumer and why it settles the question. If a necessary handoff was not
traced, use suspected_unverified or not_examined, never no_issue. Prioritize within the same budget;
do not invent defects or trace irrelevant modules. Test defects need a concrete fixture/assertion
blind spot, not a generic request for coverage. Use checked-source observations, not private reasoning.
Return the normal report separately from triage in the requested wrapper. Prefix finding IDs with C-.
Account for every supplied question once, including those you could not examine.
checked_sources paths are relative to after/ (before/ for a deleted file), with no after/ or before/ prefix.
Questions:
""" + json.dumps(questions, ensure_ascii=False)
    response = run_call(args, frozen, "investigate", prompt, args.output / "investigation.schema.json", metrics)
    validate(response, schemas["investigation"])
    report, triage = response["report"], response["triage"]
    validate_search(args.case, report, changed, schemas["report"])
    require(all(finding["id"].startswith("C-") for finding in report["findings"]), "Incorrect ID prefix")
    validate_triage(args.case, triage, questions, schemas["investigation"]["properties"]["triage"])
    require(report["findings"] or not any(entry["status"] == "reported" for entry in triage["questions"]),
            "Question marked reported without a finding")
    metrics["calls"][-1]["status"] = "completed"
    save(args.output / "triage.json", triage)
    limitations = questions_response["limitations"] + report["limitations"] + triage["limitations"]
    for entry in triage["questions"]:
        if entry["status"] in ("suspected_unverified", "not_examined"):
            limitations.append(f"{entry['id']}: {entry['status']}: {entry['observation']}")
    metrics["candidate_count"] = len(report["findings"])
    return report["findings"], [{"search": 2, "files": report["coverage"]}], limitations


def verify_response(case, response, candidates, changed, schema):
    validate(response, schema)
    candidate_ids = {c["id"] for c in candidates}
    decision_ids = [d["id"] for d in response["decisions"]]
    require(len(decision_ids) == len(set(decision_ids)) and set(decision_ids) == candidate_ids,
            "Missing, duplicate or unrelated candidate decisions")
    accepted = response["accepted_findings"]
    accepted_ids = [f["id"] for f in accepted]
    require(len(accepted_ids) == len(set(accepted_ids)) and set(accepted_ids) <= candidate_ids,
            "Duplicate or unknown accepted findings")
    canonical_ids = {d["canonical_id"] for d in response["decisions"] if d["decision"] == "accept"}
    require(canonical_ids == set(accepted_ids), "Findings inconsistent with decisions")
    decisions_by_id = {d["id"]: d for d in response["decisions"]}
    for canonical_id in accepted_ids:
        own = decisions_by_id[canonical_id]
        require(own["decision"] == "accept" and own["canonical_id"] == canonical_id,
                "Canonical finding missing its own accept decision")
    for decision in response["decisions"]:
        if decision["decision"] != "accept":
            require(decision["canonical_id"] == "-", "Excluded decision has a canonical reference")
    for finding in accepted:
        location(case, finding)
    return accepted


def totals(metrics):
    calls = metrics["calls"]
    usages = [call["usage"] for call in calls if isinstance(call.get("usage"), dict)]
    keys = sorted({key for usage in usages for key, value in usage.items() if type(value) is int})
    return {"elapsed_seconds": round(sum(call.get("elapsed_seconds") or 0 for call in calls), 3),
            "usage": {key: sum(usage.get(key, 0) for usage in usages) for key in keys}}


def main(args):
    args.case = args.case.resolve()
    args.output = args.output.resolve()
    require(args.case.is_dir(), "Missing case")
    require(not args.output.is_relative_to(args.case) and not args.case.is_relative_to(args.output),
            "Output and case must be in separate directories")
    require(all((args.case / name).exists() for name in REQUIRED), "Incomplete case")
    require((args.case / "before").is_dir() and (args.case / "after").is_dir(), "Missing sources")
    require(args.effort != "xhigh" or bool(args.effort_reason and args.effort_reason.strip()),
            "xhigh requires an explicit rationale with --effort-reason")
    require(math.isfinite(args.timeout_seconds) and args.timeout_seconds > 0, "Invalid time limit")
    require(args.strategy in ("generic", "questions"), "Invalid review strategy")
    require(type(args.tool_budget) is int and args.tool_budget > 0, "Invalid instructed tool budget")
    require(not args.output.exists(), "Output directory must be new")
    frozen = fingerprint(args.case)
    changed = changed_paths(args.case)
    manifest = json.loads((args.case / "manifest.json").read_text(encoding="utf-8"))
    require(isinstance(manifest, dict) and isinstance(manifest.get("changed_files"), list) and
            sorted(manifest["changed_files"]) == changed, "Manifest differs from changed paths")
    args.output.mkdir(parents=True)
    schemas = {name: json.loads((ROOT / "references" / f"{name}.schema.json").read_text(encoding="utf-8"))
               for name in ("report", "verification", "questions", "triage")}
    schemas["investigation"] = {"type": "object", "properties": {"report": schemas["report"], "triage": schemas["triage"]},
                                "required": ["report", "triage"], "additionalProperties": False}
    if args.strategy == "questions":
        save(args.output / "investigation.schema.json", schemas["investigation"])
    metrics = {"status": "running", "case_fingerprint": frozen, "changed_paths": changed,
               "strategy": args.strategy, "instructed_tool_budget": args.tool_budget,
               "timeout_seconds": args.timeout_seconds,
               "effort_reason": args.effort_reason, "calls": [], "thread_ids": []}
    accepted, decisions, coverage, limitations = [], [], [], []
    try:
        base = prompt_base(args.case, changed)
        candidates = []
        if args.strategy == "questions":
            candidates, coverage, limitations = question_discovery(args, frozen, changed, schemas, metrics)
        for index, focus in enumerate(("contract and correctness", "flows, regressions and security")
                                      if args.strategy == "generic" else (), 1):
            response = run_call(args, frozen, f"search-{index}", base +
                                f"\nIndependent search: {focus}. Prefix IDs with S{index}-.",
                                ROOT / "references/report.schema.json", metrics)
            validate_search(args.case, response, changed, schemas["report"])
            require(all(f["id"].startswith(f"S{index}-") for f in response["findings"]), "Incorrect ID prefix")
            metrics["calls"][-1]["status"] = "completed"
            candidates.extend(response["findings"])
            coverage.append({"search": index, "files": response["coverage"]})
            limitations.extend(response["limitations"])
        require(len({c["id"] for c in candidates}) == len(candidates), "Duplicate IDs across searches")
        response = run_call(args, frozen, "verify", base +
            "\nIndependently verify every candidate against sources and diff. "
            "Decide accept, reject or unverified for every ID with specific evidence. "
            "Distinguish regressions, incomplete new behavior, material test defects and preexisting issues. "
            "Do not present a preexisting issue as introduced by this change. "
            "Deduplicate only defects with the same demonstrated cause, trigger and consequence. "
            "accepted_findings contains demonstrated findings with checked locations and an "
            "original canonical ID. Every accept decision points to that canonical_id; "
            "the canonical candidate has its own self-referencing accept decision; "
            "reject and unverified use canonical_id '-'. Keep distinct defects separate.\n" +
            json.dumps(candidates, ensure_ascii=False), ROOT / "references/verification.schema.json", metrics)
        accepted.extend(verify_response(args.case, response, candidates, changed, schemas["verification"]))
        metrics["calls"][-1]["status"] = "completed"
        decisions.extend(response["decisions"])
        limitations.extend(response["limitations"])
        findings = sorted(accepted, key=lambda f: (f["severity"], f["file"], f["line_start"], f["id"]))
        limitations = list(dict.fromkeys(limitations))
        save(args.output / "findings.json", {"findings": findings, "decisions": decisions,
                                             "coverage": coverage, "limitations": limitations})
        lines = ["# Local review", "", f"Confirmed findings: {len(findings)}. Candidates: {len(candidates)}.",
                 "", "Results from static source inspection.", ""]
        for field in ("target", "base", "head"):
            if field in manifest:
                lines.append(f"{field}: {manifest[field]}")
        summary = totals(metrics)
        lines += [f"Sum of serial call durations: {summary['elapsed_seconds']} seconds.",
                  f"Total recorded usage: {json.dumps(summary['usage'], ensure_ascii=False)}.", ""]
        for finding in findings:
            side = location(args.case, finding)
            lines += [f"- {finding['severity']} {side}/{finding['file']}:{finding['line_start']} — {finding['title']}",
                      f"  {finding['trigger']} → {finding['consequence']}", f"  Evidence: {finding['evidence']}",
                      f"  Contract: {finding['contract_basis']}"]
        unverified = sum(d["decision"] == "unverified" for d in decisions)
        lines += ["", f"Unverified candidates: {unverified}."]
        lines += ["", "## Coverage", ""]
        for search in coverage:
            for entry in search["files"]:
                lines.append(f"- Search {search['search']}, {entry['file']}: " +
                             "; ".join(entry["aspects"]) + f". Evidence: {entry['evidence']}")
        if args.strategy == "questions":
            triage = json.loads((args.output / "triage.json").read_text(encoding="utf-8"))
            lines += ["", "## Question dispositions", ""]
            for entry in triage["questions"]:
                lines.append(f"- {entry['id']}: {entry['status']}; last consumer: {entry['last_consumer']}; "
                             f"sources: {', '.join(entry['checked_sources']) or 'none'}. {entry['observation']}")
        lines += ["", "## Limitations", ""] + [f"- {limit}" for limit in limitations]
        (args.output / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
        metrics["status"] = "complete"
    except Exception as error:
        metrics["status"] = "failed"
        metrics["failure"] = str(error)
        if metrics["calls"] and metrics["calls"][-1].get("status") != "completed":
            metrics["calls"][-1]["status"] = "failed"
        raise
    finally:
        metrics["totals"] = totals(metrics)
        save(args.output / "metrics.json", metrics)


def selfcheck():
    events = [{"type": "turn.completed", "usage": {"input_tokens": 7}}]
    with tempfile.TemporaryDirectory() as folder:
        case = Path(folder)
        (case / "after").mkdir()
        source = case / "after/a.py"
        source.write_text("print(1)\n", encoding="utf-8")
        frozen = fingerprint(case)
        source.write_text("print(2)\n", encoding="utf-8")
        invalid = {"id": "S1-1", "severity": "P2", "file": "a.py", "line_start": 2, "line_end": 2,
                   "title": "defect", "trigger": "input", "consequence": "error", "evidence": "line",
                   "contract_basis": "contract"}
        verification = {"decisions": [{"id": "S1-1", "decision": "accept", "evidence": "line",
                                       "canonical_id": "S1-1"}], "accepted_findings": [invalid], "limitations": []}
        schema = json.loads((ROOT / "references/verification.schema.json").read_text(encoding="utf-8"))
        first = {**invalid, "id": "A", "line_start": 1, "line_end": 1}
        second = {**first, "id": "B"}
        contradictory = {"decisions": [{"id": "A", "decision": "reject", "evidence": "excluded", "canonical_id": "-"},
                                        {"id": "B", "decision": "accept", "evidence": "evidence", "canonical_id": "A"}],
                         "accepted_findings": [first], "limitations": []}
        checks = [lambda: check_completion(1, events), lambda: unchanged(case, frozen),
                  lambda: check_model({"model": "other", "effort": "medium"}, MODEL, "medium"),
                  lambda: verify_response(case, contradictory, [first, second], ["a.py"], schema),
                  lambda: verify_response(case, verification, [invalid], ["a.py"], schema)]
        for check in checks:
            try:
                check()
            except ValueError:
                continue
            raise AssertionError("Safety check bypassed")
        valid = {**contradictory, "decisions": [{"id": name, "decision": "accept", "evidence": "evidence",
                                                 "canonical_id": "A"} for name in ("A", "B")]}
        require(verify_response(case, valid, [first, second], ["a.py"], schema) == [first], "Valid deduplication rejected")
        (case / "before").mkdir()
        source.rename(case / "before/a.py")
        require(location(case, first) == "before", "Incorrect deleted-file location")
        require(verify_response(case, valid, [first, second], ["a.py"], schema) == [first], "Valid deleted-file finding rejected")
        try:
            location(case, invalid)
        except ValueError:
            pass
        else:
            raise AssertionError("Invalid deleted-file range accepted")
    # Exercise each stage with a chosen model and recorded session contexts.
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder)
        case, output = root / "case", root / "output"
        case.mkdir()
        output.mkdir()
        sessions = root / "sessions"
        sessions.mkdir()
        model = 'chosen"model'
        args = argparse.Namespace(case=case, output=output, codex="codex", model=model,
                                  effort="medium", timeout_seconds=1)
        metrics = {"calls": [], "thread_ids": []}
        commands = []

        class FakeProcess:
            returncode = 0

            def __init__(self, command, **kwargs):
                commands.append(command)
                thread = f"session-{len(commands)}"
                context = {"type": "turn_context", "payload": {"model": model, "effort": "medium",
                           "approval_policy": "never", "sandbox_policy": {"type": "read-only"}}}
                (sessions / f"{thread}.jsonl").write_text(json.dumps(context) + "\n", encoding="utf-8")
                Path(command[command.index("-o") + 1]).write_text("{}", encoding="utf-8")
                self.thread = thread

            def communicate(self, prompt, timeout):
                return "\n".join(json.dumps(event) for event in (
                    {"type": "thread.started", "thread_id": self.thread},
                    {"type": "turn.completed", "usage": {"input_tokens": 1}})), ""

        with patch.dict(os.environ, {"CODEX_HOME": str(root)}), patch.object(subprocess, "Popen", FakeProcess):
            for stage in ("search-1", "search-2", "verify"):
                run_call(args, fingerprint(case), stage, "prompt", root / "schema.json", metrics)
        for command, record in zip(commands, metrics["calls"]):
            require(record["status"] == "returned", "Unvalidated response marked completed")
            require(command[command.index("-m") + 1] == model, "Chosen model not passed to CLI")
            require(f"review_model={json.dumps(model)}" in command, "Chosen model not safely configured")
            require(record["requested_model"] == model and record["effective"]["model"] == model,
                    "Chosen model not recorded")
        for context in ({"model": "other", "effort": "medium"},
                        {"model": model, "effort": "xhigh"}):
            try:
                check_model(context, model, "medium")
            except ValueError:
                continue
            raise AssertionError("Model or effort mismatch accepted")
    print("Self-check passed: model selection, safety, canonical integrity, deduplication and deleted-file locations.")


if __name__ == "__main__":
    if sys.argv[1:] == ["--selfcheck"]:
        selfcheck()
    else:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument("--case", type=Path, required=True)
        parser.add_argument("--output", type=Path, required=True)
        parser.add_argument("--codex", required=True)
        parser.add_argument("--timeout-seconds", type=float, required=True)
        parser.add_argument("--model", default=MODEL, help=f"Codex model (default: {MODEL})")
        parser.add_argument("--effort", choices=("medium", "xhigh"), default="medium")
        parser.add_argument("--effort-reason")
        parser.add_argument("--strategy", choices=("generic", "questions"), default="questions",
                            help="Review strategy (default: questions; generic for explicit comparisons or requests)")
        parser.add_argument("--tool-budget", type=int, default=24, help="Instructed tool calls per session; not a hard cap")
        try:
            main(parser.parse_args())
        except Exception as error:
            print(f"Review interrupted: {error}", file=sys.stderr)
            sys.exit(1)
