"""Local review with independent sessions and verifiable evidence."""
import argparse
from codecs import escape_decode
from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
from dataclasses import dataclass, field
from fnmatch import fnmatchcase
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
from threading import Lock
import time
from unittest.mock import patch

MODEL = "gpt-6.2-sol"
ROOT = Path(__file__).resolve().parents[1]
REQUIRED = ("before", "after", "diff.patch", "contract.md", "manifest.json")
MAX_QUESTIONS = 20
EFFORTS = ("low", "medium", "high", "xhigh")
MAX_DIFF_BYTES = 90_000
MAX_SOURCE_LINE_BYTES = 1_500
PROCESS_CLEANUP_TIMEOUT = 5
CONTRACT_LIMIT = 12_000
ANCHOR_LIMIT = 25
ANCHORS = ("AGENTS.md", "*RULES*.md", "CONTRIBUTING.md", "package.json", "pyproject.toml",
           "Cargo.toml", "go.mod", "vitest.config.*", "jest.config.*", "pytest.ini")
LOCKFILES = {"bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock",
             "pnpm-lock.yaml", "Cargo.lock", "Pipfile.lock", "poetry.lock", "uv.lock", "composer.lock", "go.sum"}
FIXTURES = {"fixtures", "__fixtures__", "testdata", "__snapshots__"}
HUNK_HEADER = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[^\n]*", re.MULTILINE)

MATERIALITY_BAR = """Report only concrete defects introduced or materially worsened by the diff,
with a realistic reachable trigger and material consequence: incorrect behavior, state or data
corruption, crashes, hangs, leaks, violated rules or documented contracts, or broken test oracles.
Exclude unchanged preexisting issues, behavior established as intentional by the contract or positive
fixtures, coverage wishes for working code, style preferences, minor duplication and speculative
edge cases without a realistic trigger. Aim for up to eight high-impact findings per lens. Never pad."""

TEST_ORACLE_BAR = """Report a test defect only when a new or modified test is absent from its intended
automated runner or CI, or its oracle can pass while its stated behavior is broken. Trace runner
configuration, task scripts and CI. A manual command alone does not wire a test into automation.
Check timers and async flushes that can run after the test finishes, discarded assertion or
inspection results, and tautological or weak assertions. Omit generic coverage wishes."""

LENSES = (
    ("lens-adversarial", "L1-", """
Enumerate supported input forms and changed arms in parsers, matchers, regular expressions, validators,
formatters, calculations, filters, loops and conditionals. Check empty, missing, boundary, duplicate,
unordered and disjoint inputs. Examine quoting, escaping, slicing, negation, delimiters, sign, precision,
rounding, units, and fallthrough for valid enum or union variants. Check loops, retries and waits for
a total deadline. Compare removed or refactored code in before/ and after/. For each defect, provide a
minimal failing input or event sequence.
"""),
    ("lens-contracts", "L2-", """
Trace changed schemas, producers, consumers and ownership of failures or async work. Read relevant
unchanged callers, consumers, schemas and sibling modules in after/. For changed variants, types,
branches, providers or handlers, check sibling switches, validators, normalizers, registries,
serializers and cleanup paths. Check for incidental metadata, formatting artifacts or stale fields
in required or semantic values. Check schemas against supported values and runtime handling, including
missing required fields. Trace transformations and chunking into downstream invariants. Follow partial
success and outer retries for duplicate side effects, cancellation through async loops, stale state
or IDs across concurrent edits, reloads or navigation, persistent errors and invalid caches, and
resource disposal on unmount, resize or cleanup.
"""),
    ("lens-rules-tests", "L3-", """
Audit changed documentation, comments and prompts sentence by sentence against implementation and
applicable AGENTS.md, repository rules and scoped instructions. Continue after the first defect.
Check factual claims and documented rules for placement, ownership, citations, precedence, identity
and hash inputs, versions and fallbacks. Look for nearby unchanged comments made stale by the diff.
When UI markup, styles or selectors change, trace selectors and layout rules against the rendered
element tree. Compare stacking, stale inline styles, selector hierarchy, accessibility and desktop
and narrow layouts in before/ and after/.
""" + TEST_ORACLE_BAR),
)

GAP_LENSES = (
    ("gap-logic", "G1-", """
Revisit changed functions, branches, switch arms, parsers and matchers that Stage 1 did not cover.
Inspect neighboring branches even where a nearby defect was found. Look for distinct failing
inputs or transitions involving empty or boundary cases, quoting, escaping, delimiters, unhandled
enum or union variants, ordering or set invariants, layout or viewport changes, and other behavior
regressions in before/ versus after/. Provide a minimal failing input or event sequence.
"""),
    ("gap-contracts-docs", "G2-", """
Start with changed files that have no Stage 1 finding. Audit remaining claims, placement, ownership
and required citations in changed documentation and comments. Trace missed cross-file contracts,
sibling branches, partial-success retries, stale state or IDs, and test wiring and oracles.
""" + TEST_ORACLE_BAR),
)


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


@dataclass
class FileDiff:
    before: str | None
    after: str | None
    ranges: list[str] = field(default_factory=list)
    annotated: list[str] = field(default_factory=list)
    hunks: list[tuple[int, int, int, int]] = field(default_factory=list)
    additions: int = 0
    deletions: int = 0

    @property
    def paths(self):
        return tuple(dict.fromkeys(path for path in (self.after, self.before) if path is not None))


@dataclass(frozen=True)
class CasePacket:
    brief: str
    text: str
    inline_diff_bytes: int
    omitted_files: tuple[str, ...]


def patch_path(header, snapshot):
    token = header.removesuffix("\r").removesuffix("\t")
    if token == "/dev/null":
        return None
    if token.startswith('"') and token.endswith('"'):
        token = escape_decode(token[1:-1].encode("utf-8"))[0].decode("utf-8")
    path = Path(token)
    require(not path.anchor and ".." not in path.parts, f"Unexpected patch path: {token}")
    if token.startswith(("a/", "b/", "i/", "w/", "c/", "o/")) and not (snapshot / path).is_file():
        return token[2:]
    return token


def source_range(side, path, start, count):
    if path is None:
        return f"{side}/ absent"
    if not count:
        return f"{side}/{path} (0 lines at {start})"
    return f"{side}/{path}:{start}-{start + count - 1}"


def annotate_hunk(file_diff, header, body):
    before, before_count, after, after_count = (int(n) if n is not None else 1 for n in header.groups())
    file_diff.hunks.append((before, before_count, after, after_count))
    extent = (source_range("before", file_diff.before, before, before_count) + " -> " +
              source_range("after", file_diff.after, after, after_count))
    file_diff.ranges.append(extent)
    context = header.group().partition(" @@")[2].removesuffix("\r")
    annotated = [f"@@ {extent} @@{context}"]
    end = before + before_count, after + after_count
    for line in body.removesuffix("\n").split("\n")[1:]:
        carriage_return = line.endswith("\r")
        line = line.removesuffix("\r") or " "
        sign = line[0]
        if sign == "\\":
            annotated.append(line)
            continue
        require(sign in " +-", f"Invalid hunk line in {extent}")
        labels = []
        if sign != "+":
            labels.append(f"b{before}")
            before += 1
        if sign != "-":
            labels.append(f"a{after}")
            after += 1
        file_diff.additions += sign == "+"
        file_diff.deletions += sign == "-"
        marker = " [CR]" if carriage_return else ""
        annotated.append(f"{' '.join(labels)} | {line}{marker}")
    require((before, after) == end, f"Hunk ranges disagree with patch body: {extent}")
    file_diff.annotated.append("\n".join(annotated))


def parse_diff(case):
    """Index text hunks by both paths of a rename, sharing the annotated payload."""
    patch_text = (case / "diff.patch").read_bytes().decode("utf-8", errors="backslashreplace")
    by_path = {}
    for block in re.split(r"(?m)(?=^diff --git )", patch_text):
        headers = list(HUNK_HEADER.finditer(block))
        if not headers:
            continue
        metadata = block[:headers[0].start()].split("\n")
        before = next(line[4:] for line in metadata if line.startswith("--- "))
        after = next(line[4:] for line in metadata if line.startswith("+++ "))
        file_diff = FileDiff(patch_path(before, case / "before"), patch_path(after, case / "after"))
        ends = [header.start() for header in headers[1:]] + [len(block)]
        for header, end in zip(headers, ends):
            annotate_hunk(file_diff, header, block[header.end():end])
        for path in file_diff.paths:
            by_path[path] = file_diff
    return by_path


def snapshot_lines(path):
    if not path.is_file():
        return None
    content = path.read_bytes()
    return content.count(b"\n") + int(bool(content) and not content.endswith(b"\n"))


def source_lines(raw):
    lines = raw.decode("utf-8", errors="backslashreplace").split("\n")
    if not lines[-1]:
        lines.pop()
    return [line.removesuffix("\r") for line in lines]


def changed_index(case, changed, diffs):
    rows = []
    for path in changed:
        before = snapshot_lines(case / "before" / path)
        after = snapshot_lines(case / "after" / path)
        file_diff = diffs.get(path)
        if before is None:
            status, added, deleted = "A", after, 0
        elif after is None:
            status, added, deleted = "D", 0, before
        else:
            status = "M"
            added = file_diff.additions if file_diff else 0
            deleted = file_diff.deletions if file_diff else 0
        rows.append(f"[{status}] {path} (before: {before or 0} lines, after: {after or 0} lines, +{added}/-{deleted})")
    return "\n".join(rows) or "(none)"


def repository_anchors(after):
    matches = []
    for path in after.rglob("*"):
        relative = path.relative_to(after)
        workflow = relative.parent.as_posix() == ".github/workflows" and path.suffix in (".yml", ".yaml")
        if (workflow or any(fnmatchcase(path.name, pattern) for pattern in ANCHORS)) and path.is_file():
            priority = 0 if len(relative.parts) == 1 else 1 if workflow else 2
            matches.append((priority, relative.as_posix()))
    return [path for _, path in sorted(matches)[:ANCHOR_LIMIT]]


def inline_priority(path, size):
    fixture = any(part in FIXTURES for part in Path(path).parts[:-1])
    return fixture, size, path


def build_case_packet(case, changed, max_diff_bytes=MAX_DIFF_BYTES):
    """Build the discovery and verification briefs once and without writing to the case."""
    contract = (case / "contract.md").read_bytes()
    excerpt = contract[:CONTRACT_LIMIT].decode("utf-8", errors="ignore")
    if len(contract) > CONTRACT_LIMIT:
        excerpt += "\n[Contract excerpt truncated. Read the full contract.md in the case.]"
    diffs = parse_diff(case)
    brief = f"## contract.md\n{excerpt}\n\n## Changed files\n{changed_index(case, changed, diffs)}"
    anchors = repository_anchors(case / "after")

    payloads = {}
    changed_set = set(changed)
    for path in changed:
        file_diff = diffs.get(path)
        if file_diff is None or any(Path(source).name in LOCKFILES for source in file_diff.paths):
            continue
        primary = file_diff.after if file_diff.after in changed_set else path
        if primary not in payloads:
            text = "\n\n".join(file_diff.annotated)
            payloads[primary] = (text, len(text.encode("utf-8")), file_diff.paths)

    separator = "\n\n"
    total = sum(size for _, size, _ in payloads.values()) + len(separator) * max(0, len(payloads) - 1)
    order = list(payloads)
    if total > max_diff_bytes:
        order.sort(key=lambda path: inline_priority(path, payloads[path][1]))
    selected, inlined_paths, inline_size = [], set(), 0
    for path in order:
        text, size, sources = payloads[path]
        size += len(separator) if selected else 0
        if inline_size + size <= max_diff_bytes:
            selected.append(text)
            inline_size += size
            inlined_paths.update(sources)

    parts = [brief, "## Repository anchors in after/\n" + ("\n".join(anchors) or "(none)")]
    if total > max_diff_bytes:
        ranges = [
            f"{path}:\n" + "\n".join(f"  {extent}" for extent in diffs[path].ranges)
            if path in diffs else f"{path}: no text hunks"
            for path in changed
        ]
        parts.append("## Complete hunk ranges by changed path\n" + "\n".join(ranges))
    parts.append("## Annotated diff (b = before/ line, a = after/ line)\n" +
                 (separator.join(selected) or "(no inline hunks)"))
    omitted = tuple(path for path in changed if path not in inlined_paths)
    if omitted:
        parts.append("## Files omitted from the inline diff (read directly from after/ or before/)\n" +
                     "\n".join(omitted))
    parts.append("Use rg -n to locate symbols and python -c with exact line slicing to read source ranges.\n"
                 "Read the surrounding source when the inline diff leaves a relationship or behavior unresolved.")
    return CasePacket(brief, "\n\n".join(parts), inline_size, omitted)


def before_boundary(hunks, position, *, end):
    """Project a zero-based boundary onto before/, including the old span of any intersecting hunk."""
    offset = 0
    for old_start, old_count, new_start, new_count in hunks:
        old_boundary = old_start - int(old_count > 0)
        new_boundary = new_start - int(new_count > 0)
        if position < new_boundary:
            break
        if position == new_boundary and end:
            return old_boundary
        if position < new_boundary + new_count:
            return old_boundary + (old_count if end else 0)
        offset = old_boundary + old_count - (new_boundary + new_count)
    return position + offset


def merged_intervals(intervals):
    start, end = intervals[0]
    for next_start, next_end in intervals[1:]:
        if next_start > end + 1:
            yield start, end
            start, end = next_start, next_end
        else:
            end = max(next_end, end)
    yield start, end


def build_candidate_snippets(case, candidates, context_lines=20, max_bytes=48_000):
    """Return budgeted, numbered source windows for validated candidate locations."""
    intervals, sources = {}, {}
    diffs = None

    def source(path):
        if path not in sources:
            raw = path.read_bytes()
            sources[path] = raw, source_lines(raw)
        return sources[path]

    for candidate in candidates:
        file = candidate["file"]
        path = question_source(case, file)
        after = path.is_relative_to(case / "after")
        raw, lines = source(path)
        start = max(1, candidate["line_start"] - context_lines)
        end = min(len(lines), candidate["line_end"] + context_lines)
        intervals.setdefault(("after" if after else "before", file), []).append((start, end))

        if not after:
            continue
        if diffs is None:
            diffs = parse_diff(case)
        diff = diffs.get(file)
        old_file = diff.before if diff else file
        if old_file is None:
            continue
        previous = case / "before" / old_file
        require(previous.resolve().is_relative_to((case / "before").resolve()), "Invalid before source path")
        if not previous.is_file():
            continue
        old_raw, old_lines = source(previous)
        if not old_lines or old_raw == raw:
            continue
        hunks = diff.hunks if diff else []
        old_start = max(1, min(len(old_lines), before_boundary(hunks, start - 1, end=False) + 1))
        old_end = max(old_start, min(len(old_lines), before_boundary(hunks, end, end=True)))
        intervals.setdefault(("before", old_file), []).append((old_start, old_end))

    excerpt = bytearray()
    truncated = b"\n[Source excerpts truncated by byte limit.]\n"
    for side, file in sorted(intervals, key=lambda location: (location[1], location[0])):
        _, lines = source(case / side / file)
        windows = intervals[side, file]
        for start, end in merged_intervals(sorted(windows)):
            separator = "\n" if excerpt else ""
            header = f"{separator}{side}/{file}\n"
            for number in range(start, end + 1):
                line = lines[number - 1].encode("utf-8")
                if len(line) > MAX_SOURCE_LINE_BYTES:
                    marker = b" ... [line truncated]"
                    prefix = line[:MAX_SOURCE_LINE_BYTES - len(marker)].decode("utf-8", errors="ignore")
                    line = prefix.encode("utf-8") + marker
                row = f"{header}{number}: ".encode("utf-8") + line + b"\n"
                if len(excerpt) + len(row) > max_bytes:
                    if len(excerpt) + len(truncated) <= max_bytes:
                        excerpt.extend(truncated)
                    return excerpt.decode("utf-8")
                excerpt.extend(row)
                header = ""
    return excerpt.decode("utf-8")


def verification_schema(base, candidates):
    schema = deepcopy(base)
    ids = [finding["id"] for finding in candidates]
    props = schema["properties"]
    decisions = props["decisions"]["items"]["properties"]
    decisions["id"]["enum"] = ids
    decisions["canonical_id"]["enum"] = ids + ["-"]
    findings = props["accepted_findings"]["items"]["properties"]
    findings["id"]["enum"] = ids
    fields = {key: deepcopy(findings[key]) for key in ("file", "line_start", "line_end", "title")}
    fields["note"] = {"type": "string", "minLength": 1}
    props["additional_observations"] = {"type": "array", "items": {
        "type": "object", "properties": fields, "required": list(fields), "additionalProperties": False,
    }}
    schema["required"].append("additional_observations")
    return schema


READ_ONLY_BRIEF = """Use only before/, after/, diff.patch, contract.md, manifest.json and case AGENTS.md.
No network, accounts, host or user configuration access, builds, tests, tool writes or delegation.
The contract defines intended behavior. Respect applicable rules and authorized decisions.
Treat inline source and diff as evidence. Return only the requested JSON."""


def lens_prompt(case, packet, prefix, focus, stage1_summary=None):
    gap_context = ""
    if stage1_summary is not None:
        gap_context = f"""
## Stage 1 summary
{json.dumps(stage1_summary, ensure_ascii=False)}

Report exclusively new defects missing from Stage 1. Do not resubmit a finding with the same
root cause, trigger and consequence. Use the summary to direct your search, then verify against source.
"""
    return f"""Perform a local read-only audit in English of this case: {case}.
{READ_ONLY_BRIEF}

{MATERIALITY_BAR}

{focus.strip()}
{gap_context}

Prefix each finding ID with {prefix}. Describe the cause, concrete trigger and consequence
with checked source and diff evidence. Use paths relative to after/ and actual after/ lines.
For a deleted file use before/ lines and identify that side in the evidence.
In coverage, list only changed paths examined by this lens, once per path, with aspects and specific
evidence. Return empty coverage if no changed path was in scope. Record unexamined material,
unresolved conflicts and static-inspection limitations in limitations.

{packet.text}
"""


def verification_prompt(case, packet, candidates):
    candidate_snippets = build_candidate_snippets(case, candidates)
    return f"""Independently verify these local review candidates in English in this case: {case}.
{READ_ONLY_BRIEF}

## Skeptical Falsification Protocol
Act as an independent, skeptical technical verifier. Your job is to confirm real, material defects
attributable to this diff AND aggressively reject false positives, preexisting issues, intentional
behavior, and low-value nits. Check before/ and after/ and confirm the trigger and consequence.

REJECT a candidate when:
1. Preexisting: before/ already had the same defect and the diff did not materially worsen it.
2. Intended or contracted: contract.md or positive fixtures expressly establish the behavior as intended.
3. Unreachable or artificial: no supported caller or realistic input can reach the faulty state.
   Verify callers in after/ when unsure.
4. Test-coverage wishlist or nit: the test omits a hypothetical future regression that production
   code currently handles, or only duplicates a harmless test.
5. Style or comment preference: no concrete broken rule, factual falsehood or observable consequence.

ACCEPT verified runtime defects and regressions, cross-file contract or sibling omissions, factual
doc/comment falsehoods, documented rule violations (including ownership, placement and citations),
and genuinely unwired runner/CI tests or broken oracles that can pass while the bug happens.
Deduplicate only when the root cause, trigger and consequence all match. Keep the sharpest
candidate as canonical, and preserve distinct triggers or consequences.

Exact source excerpts for candidates are embedded below up to the byte cap. Only run shell
commands when you need evidence not shown there, such as an unchanged caller, guard, configuration
file or omitted before/ or after/ lines.

Decide accept, reject or unverified for each submitted ID exactly once, with specific evidence.
Each accept decision points to a canonical ID, and each canonical accepted finding has its own
self-referencing accept. Reject and unverified use canonical_id "-".
Give accepted findings real source paths and line ranges, relative to after/ (before/ for deletions).
New observations go in additional_observations, with a source-relative file, line range, title
and note. Use an empty array if none. Use only submitted IDs in decisions and accepted_findings.

{packet.brief}

## Candidate source excerpts
{candidate_snippets or "(no excerpts fit the byte limit)"}

## Candidates
{json.dumps(candidates, ensure_ascii=False, indent=2)}
"""



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
    lines = len(source_lines(path.read_bytes()))
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


def kill_process_tree(process):
    if os.name == "nt":
        try:
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
                           creationflags=subprocess.CREATE_NO_WINDOW, timeout=PROCESS_CLEANUP_TIMEOUT)
        except (OSError, subprocess.TimeoutExpired):
            pass  # Still kill the immediate child if taskkill could not finish.
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    process.kill()


class ReviewProcesses:
    def __init__(self):
        self.lock = Lock()
        self.active = set()
        self.cancelled = False

    def start(self, command, **options):
        with self.lock:
            require(not self.cancelled, "Review cancelled before session launch")
            process = subprocess.Popen(command, start_new_session=os.name != "nt", **options)
            self.active.add(process)
            return process

    def discard(self, process):
        with self.lock:
            self.active.discard(process)

    def cancel(self):
        with self.lock:
            if self.cancelled:
                return
            self.cancelled = True
            for process in self.active:
                kill_process_tree(process)


def drain_terminated_process(process):
    try:
        return process.communicate(timeout=PROCESS_CLEANUP_TIMEOUT)
    except subprocess.TimeoutExpired as error:
        if os.name != "nt":
            for pipe in (process.stdin, process.stdout, process.stderr):
                pipe.close()
        # On Windows a reader thread can still hold its pipe lock after a drain timeout.
        process.poll()
        return tuple((stream or b"").decode("utf-8", errors="replace")
                     for stream in (error.stdout, error.stderr))


def failure_message(error):
    return str(error) or type(error).__name__


def run_call(args, frozen, label, prompt, schema_path, metrics):
    unchanged(args.case, frozen)
    material_seal = hashlib.sha256(json.dumps(sorted(frozen.items()), ensure_ascii=False,
                                              separators=(",", ":")).encode("utf-8")).hexdigest()
    prompt += f"\nReview material SHA-256: {material_seal}\nReview stage: {label}\n"
    prompt += f"\nBudget: up to {getattr(args, 'tool_budget', 24)} effective tool calls and {args.timeout_seconds:g} seconds per session. Tool count is an instructed limit.\n"
    (args.output / f"{label}.prompt.txt").write_bytes(prompt.encode("utf-8"))
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
    # Lens workers receive only stage-local lists. The coordinator writes their aggregate metrics.
    metrics["calls"].append(record)
    if "status" in metrics:
        save(args.output / "metrics.json", metrics)
    processes = getattr(args, "processes", None) or ReviewProcesses()
    process = processes.start(command, cwd=args.case, stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              encoding="utf-8", errors="replace",
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    try:
        stdout, stderr = process.communicate(prompt, timeout=args.timeout_seconds)
    except subprocess.TimeoutExpired:
        record["timed_out"] = True
        kill_process_tree(process)
        stdout, stderr = drain_terminated_process(process)
    except BaseException:
        kill_process_tree(process)
        drain_terminated_process(process)
        raise
    finally:
        processes.discard(process)
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
    if "status" in metrics:
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
        require(1 <= question["line"] <= len(source_lines(source.read_bytes())),
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


def run_lens_stage(args, frozen, changed, packet, schema, metrics, lenses, effort, stage1_summary=None):
    stage_args = argparse.Namespace(**(vars(args) | {"effort": effort}))
    changed_set = set(changed)

    def run_lens(lens):
        label, prefix, focus = lens
        local = {"calls": [], "thread_ids": []}
        try:
            unchanged(args.case, frozen)
            response = run_call(stage_args, frozen, label, lens_prompt(args.case, packet, prefix, focus, stage1_summary),
                                ROOT / "references/report.schema.json", local)
            unchanged(args.case, frozen)
            validate(response, schema)
            covered = [entry["file"] for entry in response["coverage"]]
            require(len(covered) == len(set(covered)) and set(covered) <= changed_set,
                    "Duplicate or unchanged paths in lens coverage")
            require(all(entry["aspects"] for entry in response["coverage"]), "Coverage without examined aspects")
            ids = [finding["id"] for finding in response["findings"]]
            require(len(ids) == len(set(ids)) and all(name.startswith(prefix) and len(name) > len(prefix) for name in ids),
                    "Duplicate or incorrectly prefixed lens IDs")
            for finding in response["findings"]:
                location(args.case, finding)
            return local, response, None
        except Exception as error:
            return local, None, error

    call_start = len(metrics["calls"])
    prefix_threads = metrics["thread_ids"][:]
    results, failures = {}, []

    def collect(index, result):
        results[index] = result
        threads = prefix_threads[:]
        failures.clear()
        for slot, (local, _, error) in sorted(results.items()):
            label = lenses[slot][0]
            record = local["calls"][0] if local["calls"] else {"stage": label}
            for thread in local["thread_ids"]:
                if thread in threads and error is None:
                    error = ValueError("Session context reused")
                threads.append(thread)
            if error is None:
                record["status"] = "completed"
            else:
                record.update(status="failed", failure=failure_message(error))
                failures.append((label, error))
            metrics["calls"][call_start + slot] = record
        metrics["thread_ids"] = threads
        save(args.output / "metrics.json", metrics)

    if args.parallel_discovery:
        metrics["calls"].extend({"stage": label, "status": "running"} for label, _, _ in lenses)
        save(args.output / "metrics.json", metrics)
        pool = ThreadPoolExecutor(max_workers=len(lenses))
        futures = {}
        try:
            for index, lens in enumerate(lenses):
                futures[pool.submit(run_lens, lens)] = index
            for future in as_completed(futures):
                collect(futures[future], future.result())
        except BaseException as error:
            args.processes.cancel()
            pool.shutdown(wait=False, cancel_futures=True)
            for future, index in futures.items():
                if index not in results and future.done() and not future.cancelled() and future.exception() is None:
                    collect(index, future.result())
            for record in metrics["calls"][call_start:]:
                if record["status"] == "running":
                    record.update(status="failed", failure=failure_message(error))
            raise
        else:
            pool.shutdown()
    else:
        for index, lens in enumerate(lenses):
            metrics["calls"].append({"stage": lens[0], "status": "running"})
            collect(index, run_lens(lens))
            if failures:
                break
    if failures:
        label, error = failures[0]
        raise ValueError(f"{label}: {error}") from error
    candidates, coverage, limitations = [], [], []
    for index, (_, response, _) in sorted(results.items()):
        candidates.extend(response["findings"])
        coverage.append({"search": call_start + index + 1, "lens": lenses[index][0], "files": response["coverage"]})
        limitations.extend(response["limitations"])
    return candidates, coverage, limitations


def lens_discovery(args, frozen, changed, packet, schema, metrics):
    candidates, coverage, limitations = run_lens_stage(
        args, frozen, changed, packet, schema, metrics, LENSES, args.effort,
    )
    if args.profile == "ultra":
        fields = ("id", "file", "line_start", "line_end", "title", "trigger")
        finding_paths = {candidate["file"] for candidate in candidates}
        stage1_summary = {
            "candidates": [{field: candidate[field] for field in fields} for candidate in candidates],
            "changed_files_without_findings": [path for path in changed if path not in finding_paths],
        }
        gap_candidates, gap_coverage, gap_limitations = run_lens_stage(
            args, frozen, changed, packet, schema, metrics, GAP_LENSES, args.gap_effort, stage1_summary,
        )
        candidates.extend(gap_candidates)
        coverage.extend(gap_coverage)
        limitations.extend(gap_limitations)
    examined = {entry["file"] for lens in coverage for entry in lens["files"]}
    limitations.extend(f"Changed path not covered by any lens: {path}" for path in changed if path not in examined)
    return candidates, coverage, limitations


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
    started = time.monotonic()
    args.case = args.case.resolve()
    args.output = args.output.resolve()
    require(args.case.is_dir(), "Missing case")
    require(not args.output.is_relative_to(args.case) and not args.case.is_relative_to(args.output),
            "Output and case must be in separate directories")
    require(all((args.case / name).exists() for name in REQUIRED), "Incomplete case")
    require((args.case / "before").is_dir() and (args.case / "after").is_dir(), "Missing sources")
    require(math.isfinite(args.timeout_seconds) and args.timeout_seconds > 0, "Invalid time limit")
    require(args.strategy in ("lenses", "generic", "questions"), "Invalid review strategy")
    uses_lenses = args.strategy == "lenses"
    args.profile = getattr(args, "profile", "standard")
    require(args.profile in ("standard", "ultra"), "Invalid review profile")
    require(args.profile != "ultra" or uses_lenses, "Profile ultra requires strategy lenses")
    args.parallel_discovery = uses_lenses and not getattr(args, "serial_discovery", False)
    args.verify_effort = getattr(args, "verify_effort", None) or ("high" if uses_lenses else args.effort)
    args.gap_effort = getattr(args, "gap_effort", "medium")
    active_efforts = [args.effort, args.verify_effort]
    if args.profile == "ultra":
        active_efforts.append(args.gap_effort)
    require("xhigh" not in active_efforts or bool(args.effort_reason and args.effort_reason.strip()),
            "xhigh requires an explicit rationale with --effort-reason")
    if args.tool_budget is None:
        args.tool_budget = 16 if uses_lenses else 24
    require(type(args.tool_budget) is int and args.tool_budget > 0, "Invalid instructed tool budget")
    max_diff_bytes = getattr(args, "max_diff_bytes", MAX_DIFF_BYTES)
    require(type(max_diff_bytes) is int and max_diff_bytes >= 0, "Invalid inline diff byte limit")
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
               "effort_reason": args.effort_reason, "calls": [], "thread_ids": [],
               "profile": args.profile, "parallel_discovery": args.parallel_discovery, "candidate_count": 0}
    args.processes = ReviewProcesses()
    accepted, decisions, coverage, limitations, observations = [], [], [], [], []
    try:
        save(args.output / "metrics.json", metrics)
        base = prompt_base(args.case, changed)
        candidates = []
        if uses_lenses:
            packet = build_case_packet(args.case, changed, max_diff_bytes)
            metrics.update(inline_diff_bytes=packet.inline_diff_bytes, inline_diff_omitted_files=list(packet.omitted_files))
            candidates, coverage, limitations = lens_discovery(args, frozen, changed, packet, schemas["report"], metrics)
        elif args.strategy == "questions":
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
        metrics["candidate_count"] = len(candidates)
        if candidates:
            schema, schema_path = schemas["verification"], ROOT / "references/verification.schema.json"
            prompt = base + (
                "\nIndependently verify every candidate against sources and diff. "
                "Decide accept, reject or unverified for every ID with specific evidence. "
                "Distinguish regressions, incomplete new behavior, material test defects and preexisting issues. "
                "Do not present a preexisting issue as introduced by this change. "
                "Deduplicate only defects with the same demonstrated cause, trigger and consequence. "
                "accepted_findings contains demonstrated findings with checked locations and an "
                "original canonical ID. Every accept decision points to that canonical_id; "
                "the canonical candidate has its own self-referencing accept decision; "
                "reject and unverified use canonical_id '-'. Keep distinct defects separate.\n" +
                json.dumps(candidates, ensure_ascii=False))
            if uses_lenses:
                schema = verification_schema(schema, candidates)
                schema_path = args.output / "verification.schema.json"
                save(schema_path, schema)
                prompt = verification_prompt(args.case, packet, candidates)
            verify_args = argparse.Namespace(**(vars(args) | {"effort": args.verify_effort}))
            response = run_call(verify_args, frozen, "verify", prompt, schema_path, metrics)
            accepted = verify_response(args.case, response, candidates, changed, schema)
            observations = response.get("additional_observations", [])
            metrics["calls"][-1]["status"] = "completed"
            decisions.extend(response["decisions"])
            limitations.extend(response["limitations"])
        unchanged(args.case, frozen)
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
        metrics["wall_seconds"] = round(time.monotonic() - started, 3)
        lines += [f"Elapsed review time: {metrics['wall_seconds']} seconds.",
                  f"Sum of call durations: {summary['elapsed_seconds']} seconds.",
                  f"Total recorded usage: {json.dumps(summary['usage'], ensure_ascii=False)}.", ""]
        for finding in findings:
            side = location(args.case, finding)
            lines += [f"- {finding['severity']} {side}/{finding['file']}:{finding['line_start']} — {finding['title']}",
                      f"  {finding['trigger']} → {finding['consequence']}", f"  Evidence: {finding['evidence']}",
                      f"  Contract: {finding['contract_basis']}"]
        if observations:
            lines += ["", "## Additional observations (unverified)", ""]
            for observation in observations:
                anchor = f"{observation['file']}:{observation['line_start']}-{observation['line_end']}"
                try:
                    anchor = f"{location(args.case, observation)}/{anchor}"
                except ValueError:
                    pass  # An unverified observation can preserve the model's original location.
                lines.append(f"- {anchor} — {observation['title']}. {observation['note']}")
        unverified = sum(d["decision"] == "unverified" for d in decisions)
        lines += ["", f"Unverified candidates: {unverified}."]
        lines += ["", "## Coverage", ""]
        for search in coverage:
            label = search.get("lens", f"Search {search['search']}")
            for entry in search["files"]:
                lines.append(f"- {label}, {entry['file']}: " +
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
    except BaseException as error:
        metrics["status"] = "failed"
        metrics["failure"] = failure_message(error)
        if metrics["calls"] and metrics["calls"][-1].get("status") in ("running", "returned"):
            record = metrics["calls"][-1]
            record["status"] = "failed"
            record.setdefault("failure", metrics["failure"])
        args.processes.cancel()
        raise
    finally:
        metrics["wall_seconds"] = round(time.monotonic() - started, 3)
        metrics["totals"] = totals(metrics)
        save(args.output / "metrics.json", metrics)


def selfcheck_lenses(case, output):
    output.mkdir()
    (case / "before").mkdir(parents=True)
    (case / "after").mkdir()
    (case / "before/sample.py").write_text("first\nsecond\nthird\n", encoding="utf-8")
    (case / "after/sample.py").write_text("first\ninserted\nsecond\nthird\n", encoding="utf-8")
    (case / "after/uv.lock").write_text("locked\n", encoding="utf-8")
    (case / "contract.md").write_text("Respect the source contract.\n", encoding="utf-8")
    (case / "diff.patch").write_text(
        "diff --git a/sample.py b/sample.py\n--- a/sample.py\n+++ b/sample.py\n"
        "@@ -1,2 +1,3 @@\n first\n+inserted\n second\n"
        "diff --git a/uv.lock b/uv.lock\n--- /dev/null\n+++ b/uv.lock\n"
        "@@ -0,0 +1 @@\n+locked\n", encoding="utf-8")
    changed = changed_paths(case)
    packet = build_case_packet(case, changed)
    require("b2 a3 |  second" in packet.text, "Incorrect annotated hunk")
    require(packet.omitted_files == ("uv.lock",) and "a1 | +locked" not in packet.text,
            "Lockfile inlined")

    candidate = {"id": "L1-1", "file": "sample.py", "line_start": 4, "line_end": 4}
    excerpts = build_candidate_snippets(case, [candidate], context_lines=0)
    require("after/sample.py\n4: third" in excerpts and "before/sample.py\n3: third" in excerpts,
            "Unaligned candidate excerpts")
    schema = json.loads((ROOT / "references/verification.schema.json").read_text(encoding="utf-8"))
    fields = verification_schema(schema, [candidate])["properties"]
    decision_fields = fields["decisions"]["items"]["properties"]
    require(decision_fields["id"]["enum"] == ["L1-1"] and decision_fields["canonical_id"]["enum"] == ["L1-1", "-"]
            and fields["accepted_findings"]["items"]["properties"]["id"]["enum"] == ["L1-1"],
            "Verifier identity schema is not constrained")

    args = argparse.Namespace(case=case, output=output, effort="medium", parallel_discovery=True,
                              processes=ReviewProcesses())
    metrics = {"calls": [], "thread_ids": []}
    report_schema = json.loads((ROOT / "references/report.schema.json").read_text(encoding="utf-8"))

    def fake_call(args, frozen, label, prompt, schema_path, local):
        local["calls"].append({"stage": label, "elapsed_seconds": 1, "usage": {"input_tokens": 2}})
        local["thread_ids"].append("thread-" + label)
        return {"findings": [], "coverage": [], "limitations": []}

    with patch.object(sys.modules[__name__], "run_call", fake_call):
        run_lens_stage(args, fingerprint(case), changed, packet, report_schema, metrics, LENSES, args.effort)
    stages = [lens[0] for lens in LENSES]
    require([call["stage"] for call in metrics["calls"]] == stages and
            metrics["thread_ids"] == ["thread-" + stage for stage in stages] and
            totals(metrics) == {"elapsed_seconds": 3, "usage": {"input_tokens": 6}},
            "Parallel evidence was not collected in lens order")


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
            prompt = (output / f"{record['stage']}.prompt.txt").read_text(encoding="utf-8")
            require(f"\nReview stage: {record['stage']}\n" in prompt, "Review stage not bound to prompt")
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
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder).resolve()
        selfcheck_lenses(root / "case", root / "output")
    print("Self-check passed: model selection, safety, canonical integrity, deduplication, deleted-file locations, "
          "diff packets, aligned snippets, verifier schema and parallel evidence.")


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
        parser.add_argument("--effort", choices=EFFORTS, default="medium")
        parser.add_argument("--verify-effort", choices=EFFORTS, help="Default: high for lenses, otherwise --effort")
        parser.add_argument("--gap-effort", choices=EFFORTS, default="medium", help="Effort for ultra gap lenses")
        parser.add_argument("--effort-reason")
        parser.add_argument("--strategy", choices=("lenses", "questions", "generic"), default="lenses",
                            help="Review strategy (default: lenses)")
        parser.add_argument("--profile", choices=("standard", "ultra"), default="standard",
                            help="Discovery depth (ultra requires lenses)")
        parser.add_argument("--tool-budget", type=int, help="Instructed tool calls per session (lenses: 16, others: 24)")
        parser.add_argument("--max-diff-bytes", type=int, default=MAX_DIFF_BYTES, help="Inline annotated diff budget")
        parser.add_argument("--serial-discovery", action="store_true", help="Run discovery lenses one at a time")
        try:
            main(parser.parse_args())
        except KeyboardInterrupt:
            print("Review interrupted: KeyboardInterrupt", file=sys.stderr)
            sys.exit(130)
        except Exception as error:
            print(f"Review interrupted: {error}", file=sys.stderr)
            sys.exit(1)
