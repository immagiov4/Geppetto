"""Local review with independent sessions and verifiable evidence."""
import argparse
from codecs import escape_decode
from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
from dataclasses import dataclass, field
from fnmatch import fnmatchcase
from itertools import zip_longest
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tempfile
from threading import Barrier, Event, Lock
import time
from unittest.mock import patch

MODEL = "gpt-6.2-sol"
ROOT = Path(__file__).resolve().parents[1]
REQUIRED = ("before", "after", "diff.patch", "contract.md", "manifest.json")
MAX_QUESTIONS = 20
EFFORTS = ("low", "medium", "high", "xhigh")
MAX_DIFF_BYTES = 120_000
MAX_SHARDS = 4
DIFF_SEPARATOR = "\n\n"
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

RULE_DOC_EXCLUSIONS = """Exclude lint warnings, optional typing or formatting guidance, and
documentation or comment mismatches for behavior explicitly rejected or unsupported by
implementation and tests, unless the issue causes a configured check to fail, breaks supported
behavior, workflow or API, or creates a safety or security defect."""

MATERIALITY_BAR = f"""Report only concrete defects introduced or materially worsened by the diff
with a reachable trigger and observable failure in the current after/ implementation: incorrect
runtime behavior, corrupt data or state, a crash, hang or leak, a broken API or protocol contract,
a materially harmful documentation falsehood or a material explicit repository rule violation,
or a genuinely broken or unwired test. Exclude unchanged defects, behavior intended by the contract,
test-strengthening wishes for working code, minor wording preferences and duplicate manifestations
of the same root cause. {RULE_DOC_EXCLUSIONS}
Aim for up to eight high-impact findings. Never pad."""

TEST_ORACLE_BAR = """Report a test defect only when one of these holds:
1. A new or modified test is absent from its intended automated runner or CI.
2. The test fails, flakes, leaks resources, or is vacuous or mocked out and exercises zero
   changed production behavior.
3. The test misses a concrete defect that exists in current after/ production code.
Trace runner configuration, task scripts and CI. A manual command alone does not wire automation.
Check the production behavior first. Exclude assertion or coverage suggestions for hypothetical
future failures when the current production code handles the case correctly."""

ADVERSARIAL_FOCUS = """Enumerate supported inputs, branches, loops, parsers, matchers, formatters,
filters and state transitions. Distinguish empty from whitespace, zero from unset, and missing
from false. Check quoting, escaping, slicing, delimiters, sign, precision, rounding and units.
Trace overbroad transformations, filters or patterns into non-target fields and user data.
Check collision-prone identity, sorting and map keys, and missing enum or union branches.
Walk repeated open/mutate/close and retry/reset cycles for accumulation or stuck state.
Check loops, retries and waits for a total deadline. Compare regressions in before/ and after/.
State the smallest supported input or event sequence that demonstrates each behavior defect."""

CONTRACT_FOCUS = """Trace changed contracts, schemas, producers, consumers and async or failure
ownership. Read relevant unchanged callers, callees and sibling modules in after/. Follow concrete
runtime types and method or error signatures through handoffs, including sync versus async, absent
values, accepted options and error returns. Check sibling switches, validators, normalizers,
registries, serializers and cleanup. Verify readiness, status and lifecycle predicates against
every state transition, shutdown configuration and pending deletion or termination. Trace partial
success plus outer retry for duplicate effects, cancellation propagation, stale state or IDs during
concurrent work, sticky errors and resource disposal."""

RULES_TESTS_FOCUS = f"""Audit changed documentation, comments and prompts against implementation,
AGENTS.md and applicable repository rules. Report factual contradictions with concrete operational,
API or user impact, or material explicit rule violations. {RULE_DOC_EXCLUSIONS}
Omit minor phrasing and historical changelog nits when implementation meets the contract.
Check alternate entry points and callers of the changed
workflow. For changed UI markup, styles or selectors, trace the rendered element tree, layout,
stacking and accessibility across viewports in before/ and after/."""

LENSES = (
    ("lens-adversarial", "L1-", ADVERSARIAL_FOCUS),
    ("lens-contracts", "L2-", CONTRACT_FOCUS),
    ("lens-rules-tests", "L3-", RULES_TESTS_FOCUS),
)

GAP_LENSES = (
    ("gap-logic", "G1-", "Start with logic and input classes missing from Stage 1.\n" + ADVERSARIAL_FOCUS),
    ("gap-contracts-docs", "G2-", "Start with files without a Stage 1 finding.\n" +
     CONTRACT_FOCUS + "\n" + RULES_TESTS_FOCUS),
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def fingerprint(case):
    """Hash regular files at paths reached through ordinary directory entries."""
    case = Path(case)
    require(not case.is_symlink(), "Symlink at case root")
    if os.name == "nt":
        require(not case.lstat().st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT,
                "Reparse point at case root")
    root = case.resolve(strict=True)
    result = {}
    pending = [(root, "")]
    while pending:
        directory, prefix = pending.pop()
        with os.scandir(directory) as entries:
            for entry in entries:
                relative = prefix + entry.name
                require(not entry.is_symlink(), f"Symlink in case: {relative}")
                # Windows junctions can leave the tree without DirEntry.is_symlink().
                if os.name == "nt":
                    attributes = entry.stat(follow_symlinks=False).st_file_attributes
                    require(not attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT,
                            f"Reparse point in case: {relative}")
                if entry.is_dir(follow_symlinks=False):
                    pending.append((entry.path, relative + "/"))
                elif entry.is_file(follow_symlinks=False):
                    with open(entry.path, "rb") as source:
                        result[relative] = hashlib.file_digest(source, "sha256").hexdigest()
    return dict(sorted(result.items()))


def unchanged(case, frozen):
    require(fingerprint(case) == frozen, "Case contents changed")


def material_seal(frozen):
    canonical = json.dumps(sorted(frozen.items()), ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def changed_paths_from_fingerprint(frozen):
    before, after = {}, {}
    for path, digest in frozen.items():
        side, _, relative = path.partition("/")
        if relative and side in ("before", "after"):
            snapshot = before if side == "before" else after
            snapshot[relative] = digest
    return sorted(path for path in before.keys() | after.keys() if before.get(path) != after.get(path))


def changed_paths(case):
    return changed_paths_from_fingerprint(fingerprint(case))


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


@dataclass(frozen=True)
class Hunk:
    file: str
    text: str
    byte_count: int
    extent: str
    truncated: bool = False


@dataclass
class Shard:
    hunks: list[Hunk] = field(default_factory=list)
    byte_count: int = 0
    modules: set[str] = field(default_factory=set)

    def add(self, hunks, byte_count, module):
        self.byte_count += byte_count + (len(DIFF_SEPARATOR) if self.hunks else 0)
        self.hunks.extend(hunks)
        self.modules.add(module)

    @property
    def text(self):
        return DIFF_SEPARATOR.join(hunk.text for hunk in self.hunks)

    @property
    def files(self):
        return list(dict.fromkeys(hunk.file for hunk in self.hunks))

    def metadata(self):
        return {"files": self.files, "hunk_count": len(self.hunks), "byte_count": self.byte_count}


@dataclass(frozen=True)
class ReviewPlan:
    brief: str
    context: str
    diffs: dict[str, FileDiff]
    shards: tuple[Shard, ...]
    rules_hunks: str
    omitted_files: tuple[str, ...]
    excluded_files: tuple[str, ...]
    truncated_hunk_ranges: tuple[str, ...]
    omitted_hunk_ranges: tuple[str, ...]

    @property
    def sharded(self):
        return self.shard_count > 1

    @property
    def shard_count(self):
        return len(self.shards)

    @property
    def inline_diff_bytes(self):
        return sum(shard.byte_count for shard in self.shards)

    def packet(self, annotated):
        if not annotated:
            return self.context
        return (self.context + "\n\n## Annotated diff (b = before/ line, a = after/ line)\n" +
                annotated)


def patch_path(header, snapshot, *, prefixed=True):
    token = header.removesuffix("\r").removesuffix("\t")
    if token == "/dev/null":
        return None
    if token.startswith('"') and token.endswith('"'):
        token = escape_decode(token[1:-1].encode("utf-8"))[0].decode("utf-8")
    path = Path(token)
    require(not path.anchor and ".." not in path.parts and (os.name != "nt" or ":" not in token),
            f"Unexpected patch path: {token}")
    if prefixed and token.startswith(("a/", "b/", "i/", "w/", "c/", "o/")) and not (snapshot / path).is_file():
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
    """Index text hunks and rename metadata by both snapshot paths."""
    patch_text = (case / "diff.patch").read_bytes().decode("utf-8", errors="backslashreplace")
    by_path = {}
    for block in re.split(r"(?m)(?=^diff --git )", patch_text):
        headers = list(HUNK_HEADER.finditer(block))
        metadata = (block[:headers[0].start()] if headers else block).split("\n")
        if headers:
            before = next(line[4:] for line in metadata if line.startswith("--- "))
            after = next(line[4:] for line in metadata if line.startswith("+++ "))
            file_diff = FileDiff(patch_path(before, case / "before"), patch_path(after, case / "after"))
            ends = [header.start() for header in headers[1:]] + [len(block)]
            for header, end in zip(headers, ends):
                annotate_hunk(file_diff, header, block[header.end():end])
        else:
            before = next((line[12:] for line in metadata if line.startswith("rename from ")), None)
            after = next((line[10:] for line in metadata if line.startswith("rename to ")), None)
            if before is None or after is None:
                continue
            file_diff = FileDiff(patch_path(before, case / "before", prefixed=False),
                                 patch_path(after, case / "after", prefixed=False))
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


def repository_anchors(paths):
    matches = []
    for relative in paths:
        parent, _, name = relative.rpartition("/")
        workflow = parent == ".github/workflows" and name.endswith((".yml", ".yaml"))
        if workflow or any(fnmatchcase(name, pattern) for pattern in ANCHORS):
            priority = 0 if not parent else 1 if workflow else 2
            matches.append((priority, relative))
    return [path for _, path in sorted(matches)[:ANCHOR_LIMIT]]


def inline_priority(path):
    *directories, name = path.lower().split("/")
    if (set(directories) & (FIXTURES | {"snapshots", "generated", "__generated__"}) or
            name.endswith((".snap", ".snapshot")) or ".generated." in name or name.endswith(".pb.go")):
        return 3
    if "test" in name or ".spec." in name or set(directories) & {"test", "tests", "__tests__", "spec", "specs"}:
        return 2
    if (set(directories) & {"doc", "docs", ".github", ".gitlab", "ci", "build", "config", "configs", "scripts"} or
            name in {"dockerfile", "makefile", "cmakelists.txt", "go.mod", "gemfile", "rakefile"} or
            name.endswith((".md", ".rst", ".adoc", ".txt", ".toml", ".ini", ".cfg", ".yaml", ".yml", ".json", ".xml")) or
            ".config." in name):
        return 1
    return 0


def annotated_size(hunks):
    return sum(hunk.byte_count for hunk in hunks) + len(DIFF_SEPARATOR) * max(0, len(hunks) - 1)


def fit_hunk(hunk, limit):
    if hunk.byte_count <= limit:
        return hunk
    header, _, body = hunk.text.partition("\n")
    marker = "\n[Hunk truncated by byte limit. Read the full range in the case.]"
    prefix = header + "\n"
    remaining = limit - len((prefix + marker).encode("utf-8"))
    if remaining < 0:
        return None
    clipped = body.encode("utf-8")[:remaining].decode("utf-8", errors="ignore")
    complete_lines = clipped.rpartition("\n")[0]
    text = prefix + (complete_lines or clipped) + marker
    return Hunk(hunk.file, text, len(text.encode("utf-8")), hunk.extent, truncated=True)


def split_hunk(hunk, limit):
    """Return bounded parts, plus parts whose headers alone leave no usable space."""
    if hunk.byte_count <= limit:
        return [hunk], []
    header, _, body = hunk.text.partition("\n")
    prefix = f"@@ {hunk.extent}"
    suffix = header.removeprefix(prefix)
    require(suffix.startswith(" @@"), "Annotated hunk header differs from its range")
    if len(header.encode("utf-8")) >= limit:
        return [], [hunk]
    rows = [(row, len(row.encode("utf-8")) + 1) for row in body.split("\n")]
    # The part count affects header length. Repack if a longer count is needed.
    digits = 1
    while True:
        parts, chunk, size = [], [], 0
        for row, row_bytes in rows:
            marker = f" [part {len(parts) + 1}/{'9' * digits}]"
            header_bytes = len((f"@@ {hunk.extent}" + marker + suffix).encode("utf-8"))
            if chunk and header_bytes + size + row_bytes > limit:
                parts.append(chunk)
                chunk, size = [], 0
                marker = f" [part {len(parts) + 1}/{'9' * digits}]"
                header_bytes = len((f"@@ {hunk.extent}" + marker + suffix).encode("utf-8"))
            if header_bytes + row_bytes > limit:
                parts.append([row])
            else:
                chunk.append(row)
                size += row_bytes
        if chunk:
            parts.append(chunk)
        if len(str(len(parts))) <= digits:
            break
        digits = len(str(len(parts)))

    fitted, omitted = [], []
    for index, part in enumerate(parts, 1):
        extent = f"{hunk.extent} [part {index}/{len(parts)}]"
        text = "\n".join([f"@@ {extent}{suffix}", *part])
        original = Hunk(hunk.file, text, len(text.encode("utf-8")), extent)
        candidate = original if original.byte_count <= limit else fit_hunk(original, limit)
        if candidate is None:
            omitted.append(original)
        else:
            fitted.append(candidate)
    return fitted, omitted


def contiguous_chunks(hunks, limit):
    chunk, size = [], 0
    for hunk in hunks:
        separator = len(DIFF_SEPARATOR) if chunk else 0
        if size + separator + hunk.byte_count > limit:
            yield chunk
            chunk, size, separator = [], 0, 0
        chunk.append(hunk)
        size += separator + hunk.byte_count
    if chunk:
        yield chunk


def pack_shards(by_file, limit, count, *, prefer_affinity=True):
    """Pack by tier and directory, preserving the largest groups and hunk boundaries when possible."""
    shards = []
    omitted = []

    def place(hunks, module):
        size = annotated_size(hunks)
        if size > limit:
            return False
        fitting = [shard for shard in shards
                   if shard.byte_count + len(DIFF_SEPARATOR) + size <= limit]
        affinity = [shard for shard in fitting if module in shard.modules]
        if prefer_affinity and affinity:
            shard = max(affinity, key=lambda candidate: candidate.byte_count)
        elif len(shards) < count and (not fitting or
                                     (prefer_affinity and module and any(candidate.modules - {""} for candidate in fitting))):
            shard = Shard()
            shards.append(shard)
        elif fitting:
            shard = max(fitting, key=lambda candidate: candidate.byte_count)
        else:
            return False
        shard.add(hunks, size, module)
        return True

    groups = {}
    for file, hunks in sorted(by_file.items(), key=lambda item: (inline_priority(item[0]), item[0])):
        module, _, _ = file.rpartition("/")
        module = module.partition("/")[0]
        groups.setdefault((inline_priority(file), module), []).append(hunks)
    def largest_hunk(files):
        return max(hunk.byte_count for hunks in files for hunk in hunks)

    # Place the hardest hunks to fit first within a tier, while keeping a directory
    # together whenever it fits. Smaller hunks can use gaps left by larger ones.
    group_order = sorted(groups, key=lambda key: (key[0], -largest_hunk(groups[key]), key[1]))
    for tier, module in group_order:
        fitted = []
        for hunks in sorted(groups[tier, module], key=lambda hunks: -largest_hunk([hunks])):
            chunks = []
            for hunk in hunks:
                parts, outside = split_hunk(hunk, limit)
                chunks.extend(parts)
                omitted.extend(outside)
            if chunks:
                fitted.append(chunks)
        group_hunks = [hunk for hunks in fitted for hunk in hunks]
        if group_hunks and place(group_hunks, module):
            continue
        for hunks in fitted:
            for chunk in contiguous_chunks(hunks, limit):
                if place(chunk, module):
                    continue
                omitted.extend(hunk for hunk in chunk if not place([hunk], module))
    return tuple(shards) or (Shard(),), omitted


def omission_score(hunks):
    """Compare coverage by tier, then by omitted hunk count and bytes within each tier."""
    sizes = [[], [], [], []]
    for hunk in hunks:
        sizes[inline_priority(hunk.file)].append(hunk.byte_count)
    return tuple((len(tier), sum(tier)) for tier in sizes)


def priority_rules_hunks(by_file, limit):
    selected = Shard()
    # Reserve the shared allowance for project rules and test evidence before supplemental UI source.
    ui_extensions = (".html", ".htm", ".css", ".scss", ".sass", ".less", ".jsx", ".tsx", ".vue", ".svelte", ".qml", ".xaml")

    def rules_priority(file):
        tier = inline_priority(file)
        return (tier if tier in (1, 2) else 3, file)

    for file in sorted(by_file, key=rules_priority):
        if inline_priority(file) not in (1, 2) and not file.lower().endswith(ui_extensions):
            continue
        hunks = by_file[file]
        for hunk in hunks:
            parts, _ = split_hunk(hunk, limit)
            for candidate in parts:
                sep = len(DIFF_SEPARATOR) if selected.hunks else 0
                if selected.byte_count + sep + candidate.byte_count <= limit:
                    selected.add([candidate], candidate.byte_count, "")
    return selected.text


def build_review_plan(case, changed, max_diff_bytes=MAX_DIFF_BYTES, max_shards=MAX_SHARDS, *, after_paths=None):
    """Build a deterministic inline plan without revisiting unchanged source contents."""
    require(type(max_diff_bytes) is int and max_diff_bytes >= 0, "Invalid inline diff byte limit")
    require(type(max_shards) is int and max_shards >= 1, "Invalid shard count limit")
    changed = sorted(changed)
    changed_set = set(changed)
    contract = (case / "contract.md").read_bytes()
    excerpt = contract[:CONTRACT_LIMIT].decode("utf-8", errors="ignore")
    if len(contract) > CONTRACT_LIMIT:
        excerpt += "\n[Contract excerpt truncated. Read the full contract.md in the case.]"
    diffs = parse_diff(case)
    brief = f"## contract.md\n{excerpt}\n\n## Changed files\n{changed_index(case, changed, diffs)}"
    if after_paths is None:
        after = case / "after"
        after_paths = (path.relative_to(after).as_posix() for path in after.rglob("*") if path.is_file())
    anchors = repository_anchors(after_paths)

    by_file, excluded = {}, set()
    for path in changed:
        diff = diffs.get(path)
        if diff is None or not diff.annotated or any(Path(source).name.lower() in LOCKFILES for source in diff.paths):
            excluded.add(path)
            continue
        primary = diff.after if diff.after in changed_set else diff.before
        if primary not in by_file:
            by_file[primary] = [Hunk(primary, text, len(text.encode("utf-8")), extent)
                                for text, extent in zip(diff.annotated, diff.ranges)]

    all_hunks = [hunk for hunks in by_file.values() for hunk in hunks]
    byte_count = annotated_size(all_hunks)
    overflow = byte_count > max_diff_bytes
    if overflow:
        # Separators between shards do not consume either shard's budget.
        separator_bytes = len(DIFF_SEPARATOR)
        capacity = max_diff_bytes + separator_bytes
        min_shards = 1
        if max_diff_bytes:
            min_shards = min(max_shards, (byte_count + separator_bytes + capacity - 1) // capacity)
        shards, omitted = pack_shards(by_file, max_diff_bytes, min_shards)
        if max_diff_bytes and max_shards > 1:
            for target in range(min_shards, max_shards + 1):
                if not omitted:
                    break
                for prefer_affinity in ((False,) if target == min_shards else (True, False)):
                    candidate, outside = pack_shards(by_file, max_diff_bytes, target,
                                                     prefer_affinity=prefer_affinity)
                    if omission_score(outside) < omission_score(omitted):
                        shards, omitted = candidate, outside
                    if not omitted:
                        break
    else:
        shards, omitted = (Shard(all_hunks, byte_count),), []
    sharded = len(shards) > 1
    omitted_files = {path for hunk in omitted for path in diffs[hunk.file].paths if path in changed_set}
    if not sharded:
        omitted_files.update(excluded)
    truncated_ranges = tuple(hunk.extent for shard in shards for hunk in shard.hunks if hunk.truncated)

    parts = [brief, "## Repository anchors in after/\n" + ("\n".join(anchors) or "(none)")]
    if overflow:
        ranges = [f"{path}:\n" + "\n".join(f"  {extent}" for extent in diffs[path].ranges)
                  if path in diffs and diffs[path].ranges else f"{path}: no text hunks"
                  for path in changed]
        parts.append("## Complete hunk ranges by changed path\n" + "\n".join(ranges))
    if sharded:
        manifest = [f"shard-{index}: {shard.byte_count} bytes, {len(shard.hunks)} hunks, "
                    + (", ".join(shard.files) or "(no files)")
                    for index, shard in enumerate(shards, 1)]
        parts.append("## Shard manifest\n" + "\n".join(manifest))
    if omitted:
        parts.append("## Hunk ranges beyond shard capacity (inspect directly in the case)\n" +
                     "\n".join(hunk.extent for hunk in omitted))
    if truncated_ranges:
        parts.append("## Truncated hunk ranges (inspect directly in the case)\n" + "\n".join(truncated_ranges))
    if excluded:
        parts.append("## Lockfiles or changes without text hunks (inspect directly when relevant)\n" +
                     "\n".join(sorted(excluded)))
    parts.append("Use rg -n to locate symbols and exact line slicing to read source ranges. "
                 "Read relevant callers and surrounding source when the inline diff leaves a contract unresolved.")
    return ReviewPlan(brief, "\n\n".join(parts), diffs, shards,
                      priority_rules_hunks(by_file, max_diff_bytes) if sharded else "",
                      tuple(sorted(omitted_files)), tuple(sorted(excluded)), truncated_ranges,
                      tuple(hunk.extent for hunk in omitted))

def build_case_packet(case, changed, max_diff_bytes=MAX_DIFF_BYTES):
    """Build the single-packet view for callers that supply one inline budget."""
    plan = build_review_plan(case, changed, max_diff_bytes, max_shards=1)
    return CasePacket(plan.brief, plan.packet(plan.shards[0].text), plan.inline_diff_bytes, plan.omitted_files)


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


def window_rows(start, end, context, line_count):
    """Prioritize the candidate's endpoints, then nearby context, then its interior."""
    if start <= end:
        yield start
    if end > start:
        yield end
    for distance in range(1, context + 1):
        if start - distance >= 1:
            yield start - distance
        if end + distance <= line_count:
            yield end + distance
    yield from range(start + 1, end)


def build_candidate_snippets(case, candidates, context_lines=20, max_bytes=48_000, *, diffs=None):
    """Keep both sides and multiple candidates represented when the excerpt budget fills."""
    sources, windows = {}, []
    diffs = parse_diff(case) if diffs is None else diffs

    def add_window(path, starts_at, ends_at):
        if path not in sources:
            sources[path] = source_lines(path.read_bytes())
        if not sources[path]:
            return
        length = len(sources[path])
        start, end = max(1, min(starts_at, length)), min(ends_at, length)
        windows.append(((path, number) for number in window_rows(start, end, context_lines, length)))

    for candidate in candidates:
        file = candidate["file"]
        source = question_source(case, file)
        start, end = candidate["line_start"], candidate["line_end"]
        add_window(source, start, end)
        if not source.is_relative_to(case / "after"):
            continue
        diff = diffs.get(file)
        old_file = diff.before if diff else file
        if old_file is None:
            continue
        before = case / "before"
        previous = before / old_file
        require(previous.resolve().is_relative_to(before.resolve()), "Invalid before source path")
        if previous.is_file():
            hunks = diff.hunks if diff else []
            old_start = before_boundary(hunks, start - 1, end=False) + 1
            old_end = max(old_start, before_boundary(hunks, end, end=True))
            add_window(previous, old_start, old_end)

    rows, headers, seen = {}, {}, set()
    marker = b"\n[Source excerpts truncated by byte limit.]\n"
    used = 0
    truncated = False
    for round_rows in zip_longest(*windows):
        for position in round_rows:
            if position is None or position in seen:
                continue
            seen.add(position)
            path, number = position
            line = sources[path][number - 1].encode("utf-8")
            if len(line) > MAX_SOURCE_LINE_BYTES:
                suffix = b" ... [line truncated]"
                line = line[:MAX_SOURCE_LINE_BYTES - len(suffix)].decode("utf-8", errors="ignore").encode() + suffix
            row = f"{number}: ".encode() + line + b"\n"
            header = b"" if path in headers else f"{path.relative_to(case).as_posix()}\n".encode()
            size = len(header) + len(row)
            if used + size > max_bytes - len(marker):
                truncated = True
                continue
            used += size
            if header:
                headers[path] = header
                rows[path] = {}
            rows[path][number] = row
        if truncated:
            break
    excerpt = b"".join(headers[path] + b"".join(lines[number] for number in sorted(lines))
                       for path, lines in rows.items())
    return (excerpt + (marker if truncated and max_bytes >= len(marker) else b"")).decode("utf-8")

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
root cause. Use the summary to direct your search, then verify against source.
"""
    return f"""Perform a local read-only audit in English of this case: {case}.
{READ_ONLY_BRIEF}

{MATERIALITY_BAR}

{focus.strip()}

{TEST_ORACLE_BAR}
{gap_context}

Prefix each finding ID with {prefix}. Describe the cause, concrete trigger and consequence
with checked source and diff evidence. Use paths relative to after/ and actual after/ lines.
For a deleted file use before/ lines and identify that side in the evidence.
In coverage, list only changed paths examined by this lens, once per path, with aspects and specific
evidence. Return empty coverage if no changed path was in scope. Record unexamined material,
unresolved conflicts and static-inspection limitations in limitations.

{packet}
"""


def verification_prompt(case, plan, candidates, *, include_observations=True):
    candidate_snippets = build_candidate_snippets(case, candidates, diffs=plan.diffs)
    locations = "\n".join(f"- {item['id']}: {item['file']}:{item['line_start']}-{item['line_end']}"
                          for item in candidates)
    observations = ("Put new, unverified observations in additional_observations, with file, line range, "
                    "title and note. Return an empty array if there are none." if include_observations else "")
    return f"""Independently verify these local review candidates in English in this case: {case}.
{READ_ONLY_BRIEF}

{MATERIALITY_BAR}

{TEST_ORACLE_BAR}

## Active falsification checklist
For every candidate confirm a real trigger and consequence against before/ and current after/.
Actively look for the guard, caller, contract, fixture or existing behavior that defeats the claim.
REJECT a candidate when any of these conditions holds:
1. Before already had the same defect and this diff did not materially worsen it.
2. The contract or positive fixtures establish the behavior as intended.
3. No supported caller or realistic input reaches the failing path. Read after/ callers when unsure.
4. The claim requests coverage or stronger assertions for a hypothetical future failure. Inspect
   current after/ production code first. If it handles the case and the test executes real
   production behavior, reject the wishlist. Apply the test oracle rules above to any test claim.
5. The claim concerns minor documentation, comment or changelog phrasing with no concrete
   operational impact. {RULE_DOC_EXCLUSIONS}
Use unverified when material evidence remains missing. State what source evidence is missing.

Consolidate by underlying defect. When accepted candidates describe the same root cause, select
one canonical finding and link every accepted duplicate to its canonical_id even if triggers or
consequences differ. Preserve ALL distinct verified triggers, consequences and supporting evidence
in the canonical finding's trigger, consequence and evidence fields. Keep independent causes separate.

Each submitted ID needs exactly one accept, reject or unverified decision with specific evidence.
Each canonical finding needs its own self-referencing accept. Reject and unverified use canonical_id "-".
Locate accepted findings in after/ with source-relative paths and real line ranges. Use before/
locations for deletions. {observations}
Use only submitted IDs for
decisions and accepted_findings.

Read additional case source when these aligned excerpts do not settle a trigger or consequence.

{plan.brief}

## Candidate locations
{locations}

## Aligned before/ and after/ candidate excerpts
{candidate_snippets or "(no excerpts fit the byte limit)"}

## Submitted candidates
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
    seal = args.seal if hasattr(args, "seal") else material_seal(frozen)
    prompt += f"\nReview material SHA-256: {seal}\nReview stage: {label}\n"
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
{MATERIALITY_BAR}

{TEST_ORACLE_BAR}

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
    require(not path.anchor and path.as_posix() == relative and ".." not in path.parts and
            (os.name != "nt" or ":" not in relative),
            "Invalid question source path")
    side = "after" if (case / "after" / path).exists() else "before"
    source = case / side / path
    require(source.resolve().is_relative_to((case / side).resolve()) and source.is_file(), "Missing question source")
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


def run_lens_stage(args, frozen, changed, schema, metrics, lenses, effort, stage1_summary=None):
    stage_args = argparse.Namespace(**(vars(args) | {"effort": effort}))
    changed_set = set(changed)

    def run_lens(lens):
        label, prefix, focus, packet = lens
        local = {"calls": [], "thread_ids": []}
        try:
            response = run_call(stage_args, frozen, label, lens_prompt(args.case, packet, prefix, focus, stage1_summary),
                                ROOT / "references/report.schema.json", local)
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
    responses = run_stage_wave(args, metrics, lenses, run_lens)
    candidates, coverage, limitations = [], [], []
    for index, response in enumerate(responses):
        candidates.extend(response["findings"])
        coverage.append({"search": call_start + index + 1, "lens": lenses[index][0], "files": response["coverage"]})
        limitations.extend(response["limitations"])
    return candidates, coverage, limitations


def run_stage_wave(args, metrics, stages, run_stage):
    """Collect independent worker results in stage order and enforce fresh sessions."""
    call_start = len(metrics["calls"])
    prefix_threads = metrics["thread_ids"][:]
    results, failures = {}, []

    def collect(index, result):
        results[index] = result
        threads = prefix_threads[:]
        failures.clear()
        for slot, (local, _, error) in sorted(results.items()):
            label = stages[slot][0]
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
        metrics["calls"].extend({"stage": label, "status": "running"} for label, *_ in stages)
        save(args.output / "metrics.json", metrics)
        pool = ThreadPoolExecutor(max_workers=len(stages))
        futures = {}
        try:
            for index, stage in enumerate(stages):
                futures[pool.submit(run_stage, stage)] = index
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
        for index, stage in enumerate(stages):
            metrics["calls"].append({"stage": stage[0], "status": "running"})
            collect(index, run_stage(stage))
            if failures:
                break
    if failures:
        label, error = failures[0]
        raise ValueError(f"{label}: {error}") from error
    return [response for _, response, _ in (results[index] for index in range(len(stages)))]


def stage1_lenses(plan):
    if not plan.sharded:
        packet = plan.packet(plan.shards[0].text)
        return [(*lens, packet) for lens in LENSES]
    shards = [
        (f"shard-{index}", f"SH{index}-",
         f"Deep-audit the assigned shard's hunks and source files: {', '.join(shard.files) or '(none)'}. "
         "Read affected callers and neighboring ranges as needed to settle local and cross-file contracts. "
         "Inspect any omitted or truncated ranges for your files directly. "
         "Give priority to the assigned hunks over the global index."
         "\n\n" + ADVERSARIAL_FOCUS + "\n\n" + CONTRACT_FOCUS,
         plan.packet(shard.text))
        for index, shard in enumerate(plan.shards, 1)
    ]
    return shards + [
        (*LENSES[1][:2],
         CONTRACT_FOCUS + "\nIndividual shards already audit intra-shard logic and local contracts. Focus on cross-shard boundaries, "
         "shared schemas or interfaces spanning multiple shards, unchanged callers or entry points outside the diff, "
         "and any omitted or truncated ranges. Do not duplicate single-file intra-shard defects.",
         plan.context),
        (*LENSES[2], plan.packet(plan.rules_hunks)),
    ]


def lens_discovery(args, frozen, changed, plan, schema, metrics):
    def checked_wave(lenses, effort, summary=None):
        try:
            return run_lens_stage(args, frozen, changed, schema, metrics, lenses, effort, summary)
        finally:
            unchanged(args.case, frozen)

    unchanged(args.case, frozen)
    candidates, coverage, limitations = checked_wave(stage1_lenses(plan), args.effort)
    if args.profile == "ultra":
        fields = ("id", "file", "line_start", "line_end", "title", "trigger")
        finding_paths = {candidate["file"] for candidate in candidates}
        stage1_summary = {
            "candidates": [{field: candidate[field] for field in fields} for candidate in candidates],
            "changed_files_without_findings": [path for path in changed if path not in finding_paths],
        }
        if plan.sharded:
            packets = (plan.context, plan.packet(plan.rules_hunks))
        else:
            packets = (plan.packet(plan.shards[0].text),) * len(GAP_LENSES)
        # The Stage 1 exit check is also the Stage 2 entry check; only memory is read between them.
        gap_lenses = [(*lens, packet) for lens, packet in zip(GAP_LENSES, packets, strict=True)]
        gap_candidates, gap_coverage, gap_limitations = checked_wave(gap_lenses, args.gap_effort, stage1_summary)
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


def partition_verify_batches(candidates, threshold=18, min_batch=4, max_batches=2, *, parallel_discovery=True):
    """Balance module groups while keeping all candidates for a file together."""
    if len(candidates) <= threshold or not parallel_discovery or max_batches < 2:
        return [candidates]

    def group(by_file):
        groups = {}
        for index, candidate in enumerate(candidates):
            file = candidate["file"]
            key = file if by_file else file.partition("/")[0]
            groups.setdefault(key, []).append(index)
        return groups

    groups = group(by_file=False)
    if max(map(len, groups.values())) * 4 > len(candidates) * 3:
        groups = group(by_file=True)
    batches = [[], []]
    for _, indexes in sorted(groups.items(), key=lambda item: (-len(item[1]), item[0])):
        min(batches, key=len).extend(indexes)
    if min(map(len, batches)) < min_batch:
        return [candidates]
    return [[candidates[index] for index in sorted(batch)] for batch in batches]


def run_verification(args, frozen, changed, plan, base_schema, candidates, metrics):
    batches = partition_verify_batches(candidates, parallel_discovery=args.parallel_discovery)
    verify_args = argparse.Namespace(**(vars(args) | {"effort": args.verify_effort}))
    uses_lenses = args.strategy == "lenses"
    schema, schema_path = base_schema, ROOT / "references/verification.schema.json"
    if uses_lenses:
        schema = verification_schema(base_schema, candidates)
        schema_path = args.output / "verification.schema.json"
        save(schema_path, schema)
    try:
        if len(batches) == 1:
            response = run_call(verify_args, frozen, "verify",
                                verification_prompt(args.case, plan, candidates, include_observations=uses_lenses),
                                schema_path, metrics)
            verify_response(args.case, response, candidates, changed, schema)
            metrics["calls"][-1]["status"] = "completed"
        else:
            def run_batch(stage):
                label, batch = stage
                local = {"calls": [], "thread_ids": []}
                try:
                    batch_schema = verification_schema(base_schema, batch)
                    batch_path = args.output / f"{label}.schema.json"
                    save(batch_path, batch_schema)
                    result = run_call(verify_args, frozen, label, verification_prompt(args.case, plan, batch),
                                      batch_path, local)
                    verify_response(args.case, result, batch, changed, batch_schema)
                    return local, result, None
                except Exception as error:
                    return local, None, error

            stages = [(f"verify-{index}", batch) for index, batch in enumerate(batches, 1)]
            responses = run_stage_wave(args, metrics, stages, run_batch)
            response = {key: [item for result in responses for item in result[key]] for key in responses[0]}
            verify_response(args.case, response, candidates, changed, schema)
    finally:
        unchanged(args.case, frozen)
    save(args.output / "verification.json", response)
    return response


def totals(metrics):
    calls = metrics["calls"]
    usages = [call["usage"] for call in calls if isinstance(call.get("usage"), dict)]
    keys = sorted({key for usage in usages for key, value in usage.items() if type(value) is int})
    return {"elapsed_seconds": round(sum(call.get("elapsed_seconds") or 0 for call in calls), 3),
            "usage": {key: sum(usage.get(key, 0) for usage in usages) for key in keys}}


def main(args):
    started = time.monotonic()
    case_path = args.case.resolve()
    args.output = args.output.resolve()
    require(args.case.is_dir(), "Missing case")
    require(not args.output.is_relative_to(case_path) and not case_path.is_relative_to(args.output),
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
    max_shards = getattr(args, "max_shards", MAX_SHARDS)
    require(type(max_diff_bytes) is int and max_diff_bytes >= 0, "Invalid inline diff byte limit")
    require(type(max_shards) is int and max_shards >= 1, "Invalid shard count limit")
    require(not args.output.exists(), "Output directory must be new")

    prep_started = time.monotonic()
    frozen = fingerprint(args.case)
    args.case = case_path
    changed = changed_paths_from_fingerprint(frozen)
    manifest = json.loads((args.case / "manifest.json").read_text(encoding="utf-8"))
    require(isinstance(manifest, dict) and isinstance(manifest.get("changed_files"), list) and
            sorted(manifest["changed_files"]) == changed, "Manifest differs from changed paths")
    args.seal = material_seal(frozen)
    args.output.mkdir(parents=True)
    schemas = {name: json.loads((ROOT / "references" / f"{name}.schema.json").read_text(encoding="utf-8"))
               for name in ("report", "verification", "questions", "triage")}
    schemas["investigation"] = {"type": "object", "properties": {"report": schemas["report"], "triage": schemas["triage"]},
                                "required": ["report", "triage"], "additionalProperties": False}
    if args.strategy == "questions":
        save(args.output / "investigation.schema.json", schemas["investigation"])
    metrics = {"status": "running", "case_fingerprint": frozen, "changed_paths": changed,
               "strategy": args.strategy, "instructed_tool_budget": args.tool_budget,
               "timeout_seconds": args.timeout_seconds, "effort_reason": args.effort_reason,
               "calls": [], "thread_ids": [], "profile": args.profile,
               "parallel_discovery": args.parallel_discovery, "candidate_count": 0,
               "prep_seconds": None, "shard_count": 0, "shards": []}
    args.processes = ReviewProcesses()
    accepted, decisions, coverage, limitations, observations = [], [], [], [], []
    try:
        try:
            after_paths = (path.removeprefix("after/") for path in frozen if path.startswith("after/"))
            plan = build_review_plan(args.case, changed, max_diff_bytes, max_shards if uses_lenses else 1,
                                     after_paths=after_paths)
        finally:
            metrics["prep_seconds"] = round(time.monotonic() - prep_started, 3)
        if uses_lenses:
            metrics.update(shard_count=plan.shard_count,
                           shards=[shard.metadata() for shard in plan.shards],
                           inline_diff_bytes=plan.inline_diff_bytes,
                           inline_diff_omitted_files=list(plan.omitted_files),
                           inline_diff_excluded_files=list(plan.excluded_files),
                           inline_diff_truncated_hunk_ranges=list(plan.truncated_hunk_ranges),
                           inline_diff_omitted_hunk_ranges=list(plan.omitted_hunk_ranges))
        save(args.output / "metrics.json", metrics)
        candidates = []
        if uses_lenses:
            candidates, coverage, limitations = lens_discovery(
                args, frozen, changed, plan, schemas["report"], metrics)
        else:
            unchanged(args.case, frozen)
            try:
                if args.strategy == "questions":
                    candidates, coverage, limitations = question_discovery(args, frozen, changed, schemas, metrics)
                else:
                    base = prompt_base(args.case, changed)
                    for index, focus in enumerate(("contract and correctness", "flows, regressions and security"), 1):
                        response = run_call(args, frozen, f"search-{index}", base +
                                            f"\nIndependent search: {focus}. Prefix IDs with S{index}-.",
                                            ROOT / "references/report.schema.json", metrics)
                        validate_search(args.case, response, changed, schemas["report"])
                        require(all(f["id"].startswith(f"S{index}-") for f in response["findings"]), "Incorrect ID prefix")
                        metrics["calls"][-1]["status"] = "completed"
                        candidates.extend(response["findings"])
                        coverage.append({"search": index, "files": response["coverage"]})
                        limitations.extend(response["limitations"])
            finally:
                unchanged(args.case, frozen)
        require(len({c["id"] for c in candidates}) == len(candidates), "Duplicate IDs across searches")
        metrics["candidate_count"] = len(candidates)
        if candidates:
            response = run_verification(args, frozen, changed, plan, schemas["verification"], candidates, metrics)
            accepted = response["accepted_findings"]
            observations = response.get("additional_observations", [])
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
                except (OSError, ValueError):
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
    selfcheck_shards()
    print("Self-check passed: model selection, safety, canonical integrity, deduplication, deleted-file locations, "
          "diff packets, aligned snippets, verifier schema and parallel evidence.")


def expect_invalid(check, message):
    try:
        check()
    except ValueError as error:
        require(message in str(error), f"Unexpected validation failure: {error}")
    else:
        raise AssertionError(f"Invalid material accepted: {message}")


def make_review_fixture(case, edits, *, extras=()):
    """Build an unambiguous zero-context patch and matching snapshots for the self-check."""
    for side in ("before", "after"):
        (case / side).mkdir(parents=True)
    patch_blocks = []
    changed = set()
    for file, old, new in edits:
        changed.add(file)
        headers = [f"diff --git a/{file} b/{file}",
                   f"--- {'a/' + file if old is not None else '/dev/null'}",
                   f"+++ {'b/' + file if new is not None else '/dev/null'}"]
        for side, content in (("before", old), ("after", new)):
            if content is not None:
                source = case / side / file
                source.parent.mkdir(parents=True, exist_ok=True)
                source.write_bytes(("\n".join(content) + "\n").encode("utf-8"))
        for number, (before, after) in enumerate(zip_longest(old or [], new or []), 1):
            if before == after:
                continue
            old_range = str(number) if before is not None else "0,0"
            new_range = str(number) if after is not None else "0,0"
            headers.append(f"@@ -{old_range} +{new_range} @@")
            if before is not None:
                headers.append("-" + before)
            if after is not None:
                headers.append("+" + after)
        patch_blocks.extend(headers)
    for side, file, data in extras:
        changed.add(file)
        source = case / side / file
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes(data)
    (case / "contract.md").write_text("Respect the source contract.\n", encoding="utf-8")
    (case / "diff.patch").write_bytes(("\n".join(patch_blocks) + "\n").encode("utf-8"))
    save(case / "manifest.json", {"changed_files": sorted(changed), "target": "selfcheck"})
    return sorted(changed)


def check_launches(case, output, plan, labels, profile, max_diff_bytes, max_shards=MAX_SHARDS):
    """Exercise CLI transport and output contracts using deterministic independent fake sessions."""
    primary = next(iter(plan.shards[0].files))
    prefix = "SH1-" if plan.sharded else "L1-"
    candidate = {"id": prefix + "1", "severity": "P2", "file": primary, "line_start": 1, "line_end": 1,
                 "title": "Behavior defect", "trigger": "first input", "consequence": "first result",
                 "evidence": "first checked line", "contract_basis": "source contract"}
    duplicate = {**candidate, "id": prefix + "2", "trigger": "second input",
                 "consequence": "second result", "evidence": "second checked line"}
    canonical = {**candidate, "trigger": "first input or second input",
                 "consequence": "first result and second result", "evidence": "first and second checked lines"}
    observation = {"file": primary, "line_start": 999, "line_end": 1_000,
                   "title": "An observation", "note": "The location remains unverified."}
    accepted_response = {"accepted_findings": [canonical], "additional_observations": [observation],
                         "limitations": [], "decisions": [
                             {"id": entry["id"], "decision": "accept", "canonical_id": candidate["id"],
                              "evidence": entry["evidence"]} for entry in (candidate, duplicate)
                         ]}
    gap_labels = ["gap-logic", "gap-contracts-docs"] if profile == "ultra" else []
    waves = [labels] + ([gap_labels] if gap_labels else [])
    check_points = []
    finished = []
    gates = {label: Barrier(len(wave), timeout=10) for wave in waves for label in wave[:1]}
    order = {label: (wave, index) for wave in waves for index, label in enumerate(wave)}
    released = {label: Event() for label in order}
    original_check = unchanged
    output_schemas = {name: json.loads((ROOT / "references" / f"{name}.schema.json").read_bytes())
                      for name in ("report", "verification")}

    class FakeProcess:
        returncode = 0

        def __init__(self, command, **options):
            require(options["creationflags"] == getattr(subprocess, "CREATE_NO_WINDOW", 0), "Window visibility flag lost")
            require(options["cwd"] == case and command[command.index("--sandbox") + 1] == "read-only",
                    "Review sandbox or working directory differs")
            require(command[command.index("-m") + 1] == MODEL, "Incorrect requested model")
            self.result = Path(command[command.index("-o") + 1])
            self.schema = json.loads(Path(command[command.index("--output-schema") + 1]).read_bytes())
            self.stage = self.result.stem
            effort = "high" if self.stage == "verify" else "medium"
            require(f'model_reasoning_effort="{effort}"' in command, "Incorrect requested effort")

        def communicate(self, prompt, timeout):
            label = self.stage
            require(f"\nReview material SHA-256: {material_seal(fast_fixture)}\nReview stage: {label}\n" in prompt,
                    "Prompt lost exact material seal or stage")
            require("up to 16 effective tool calls" in prompt, "Incorrect lens budget")
            if label == "verify":
                expected = verification_schema(output_schemas["verification"], [candidate, duplicate])
                require(self.schema == expected and f"- {candidate['id']}: {primary}:1-1" in prompt,
                        "Verify prompt or dynamic schema differs")
                require("after/" + primary in prompt and "Consolidate by underlying defect" in prompt,
                        "Verifier lost evidence or consolidation criteria")
                response = accepted_response
            else:
                require(self.schema == output_schemas["report"], "Incorrect report schema")
                if label in gap_labels:
                    require('"changed_files_without_findings"' in prompt and candidate["id"] in prompt,
                            "Missing gap-lens seed")
                if label.startswith("shard-"):
                    require(plan.shards[labels.index(label)].text in prompt, "Shard lost assigned inline hunks")
                    require("Aim for up to eight high-impact findings." in prompt and "up to six" not in prompt,
                            "Shard finding headroom differs from the materiality bar")
                if not plan.sharded and label in labels:
                    require(plan.shards[0].text in prompt, "Single packet lost inline hunks")
                if plan.sharded and label == "lens-contracts":
                    require("## Shard manifest" in prompt and "## Complete hunk ranges" in prompt and
                            CONTRACT_FOCUS in prompt and "Focus on cross-shard boundaries" in prompt,
                            "Global contracts lack cross-shard context")
                if plan.sharded and label == "lens-rules-tests":
                    require(plan.rules_hunks in prompt, "Global rules lens lost its inline selection")
                wave, index = order[label]
                gates[wave[0]].wait(timeout=timeout)
                if index + 1 < len(wave):
                    require(released[wave[index + 1]].wait(timeout=timeout), "Discovery calls did not finish")
                response = {"findings": [candidate, duplicate] if label == labels[0] else [],
                            "coverage": [], "limitations": []}
            save(self.result, response)
            finished.append(label)
            if label in released:
                released[label].set()
            return "\n".join(json.dumps(event) for event in (
                {"type": "thread.started", "thread_id": "thread-" + label},
                {"type": "turn.completed", "usage": {"input_tokens": 1}},
            )), ""

    def record_check(path, frozen):
        check_points.append(len(finished))
        original_check(path, frozen)

    fast_fixture = fingerprint(case)
    args = argparse.Namespace(case=case, output=output, codex="codex", timeout_seconds=10, model=MODEL,
                              strategy="lenses", profile=profile, effort="medium", effort_reason=None,
                              tool_budget=None, max_diff_bytes=max_diff_bytes, max_shards=max_shards)
    with patch.object(subprocess, "Popen", FakeProcess), patch.dict(globals(), {
        "unchanged": record_check,
        "effective_context": lambda _, model, effort: {"model": model, "effort": effort, "sandbox": "read-only"},
    }):
        main(args)
    metrics = json.loads((output / "metrics.json").read_bytes())
    stages = labels + gap_labels + ["verify"]
    require([call["stage"] for call in metrics["calls"]] == stages and
            metrics["thread_ids"] == ["thread-" + stage for stage in stages] and
            finished == [label for wave in waves for label in reversed(wave)] + ["verify"],
            "Discovery or metrics evidence order differs")
    expected_checks = [0, len(labels)] + ([len(labels) + len(gap_labels)] if gap_labels else [])
    expected_checks.append(len(stages))
    require(check_points == expected_checks, f"Integrity checks ran outside coordinator boundaries: {check_points}")
    require(metrics["status"] == "complete" and metrics["candidate_count"] == 2 and metrics["prep_seconds"] >= 0 and
            metrics["case_fingerprint"] == fast_fixture and metrics["shard_count"] == plan.shard_count and
            metrics["inline_diff_bytes"] == plan.inline_diff_bytes and
            metrics["shards"] == [shard.metadata() for shard in plan.shards] and
            metrics["totals"]["usage"] == {"input_tokens": len(stages)} and
            all(call["status"] == "completed" for call in metrics["calls"]), "Incorrect complete-run metrics")

    saved_schema = json.loads((output / "verification.schema.json").read_bytes())
    fields = saved_schema["properties"]
    ids = [candidate["id"], duplicate["id"]]
    require(fields["decisions"]["items"]["properties"]["id"]["enum"] == ids and
            fields["decisions"]["items"]["properties"]["canonical_id"]["enum"] == ids + ["-"] and
            fields["accepted_findings"]["items"]["properties"]["id"]["enum"] == ids and
            "additional_observations" in saved_schema["required"], "Verifier identity schema is not constrained")
    invalid = {**accepted_response, "accepted_findings": [{**canonical, "line_end": 999}]}
    expect_invalid(lambda: verify_response(case, invalid, [candidate, duplicate], [], saved_schema),
                   "Finding range outside source")
    findings = json.loads((output / "findings.json").read_bytes())
    require(findings["findings"] == [canonical] and findings["decisions"] == accepted_response["decisions"] and
            set(findings) == {"findings", "coverage", "decisions", "limitations"},
            "Findings contract or canonical consequences changed")
    report = (output / "report.md").read_text(encoding="utf-8")
    require("Confirmed findings: 1. Candidates: 2." in report and
            f"- {primary}:999-1000 — An observation." in report,
            "Report contract or unverified observation fallback changed")


def check_parallel_verification(case, output, plan, changed):
    """Use real orchestration with fake independent completions forced out of order."""
    files = ["source/added-è.py", "source/core.py", "source/deleted.py"]
    candidates = [{"id": f"L1-{index}", "file": files[index % len(files)], "line_start": 1, "line_end": 1,
                   "severity": "P2", "title": "Behavior defect", "trigger": "Input", "consequence": "Result",
                   "evidence": "Checked line", "contract_basis": "Source"}
                  for index in range(21)]
    batches = partition_verify_batches(candidates)
    require([len(batch) for batch in batches] == [14, 7] and
            not ({item["file"] for item in batches[0]} & {item["file"] for item in batches[1]}) and
            all(batch == [item for item in candidates if item["file"] in {entry["file"] for entry in batch}]
                for batch in batches) and
            partition_verify_batches(candidates[:18]) == [candidates[:18]] and
            partition_verify_batches(candidates, parallel_discovery=False) == [candidates] and
            partition_verify_batches([candidates[0]] * 18 + candidates[:3]) == [[candidates[0]] * 18 + candidates[:3]],
            "Batch selection lost order, split a file or dropped the minimum-size fallback")
    across_modules = [{**item, "file": f"module{index % 3}/{item['file']}"}
                      for index, item in enumerate(candidates)]
    require(partition_verify_batches(across_modules) == [[item for index, item in enumerate(across_modules) if index % 3 in (0, 2)], across_modules[1::3]],
            "Module assignment was not deterministic")

    barrier = Barrier(2, timeout=10)
    released = Event()
    completed = []
    base_schema = json.loads((ROOT / "references/verification.schema.json").read_bytes())

    def fake_batch(args, frozen, label, prompt, schema_path, metrics):
        batch = batches[int(label[-1]) - 1]
        require(args.effort == "high" and json.loads(schema_path.read_bytes()) == verification_schema(base_schema, batch)
                and prompt == verification_prompt(case, plan, batch), "Verification did not use its own prompt and schema")
        barrier.wait()
        if label == "verify-1":
            require(released.wait(10), "Second verifier did not complete concurrently")
        result = {"decisions": [{"id": item["id"], "decision": "accept", "canonical_id": item["id"],
                                 "evidence": label} for item in batch],
                  "accepted_findings": batch, "additional_observations": [], "limitations": [label]}
        save(output / f"{label}.json", result)
        metrics["calls"].append({"stage": label, "usage": {"input_tokens": 1}})
        metrics["thread_ids"].append("thread-" + label)
        completed.append(label)
        if label == "verify-2":
            released.set()
        return result

    args = argparse.Namespace(case=case, output=output, codex="codex", timeout_seconds=10, model=MODEL,
                              strategy="lenses", effort="medium", effort_reason=None, tool_budget=None)
    with patch.dict(globals(), {"lens_discovery": lambda *_: (candidates, [], []), "run_call": fake_batch}):
        main(args)
    labels = ["verify-1", "verify-2"]
    results = [json.loads((output / f"{label}.json").read_bytes()) for label in labels]
    verification = json.loads((output / "verification.json").read_bytes())
    verify_response(case, verification, candidates, changed, verification_schema(base_schema, candidates))
    require(verification == {key: results[0][key] + results[1][key] for key in results[0]},
            "Merged verification is not in batch order")
    review = json.loads((output / "findings.json").read_bytes())
    metrics = json.loads((output / "metrics.json").read_bytes())
    require(set(review) == {"findings", "decisions", "coverage", "limitations"} and
            review["decisions"] == verification["decisions"] and len(review["findings"]) == len(candidates) and
            completed == labels[::-1] and [call["stage"] for call in metrics["calls"]] == labels and
            metrics["thread_ids"] == ["thread-" + label for label in labels],
            "Review schema, actual verification concurrency, or final stage order differs")


def selfcheck_shards():
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder).resolve()
        small = root / "small"
        small_changed = make_review_fixture(
            small, [("source/core.py", ["old"], ["new"]), ("source/deleted.py", ["old"], None),
                    ("source/added-è.py", None, ["new"]), ("uv.lock", None, ["locked"])],
            extras=[("after", "binary.dat", b"\x00\xff")])
        frozen = fingerprint(small)
        original = {path.relative_to(small).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                    for path in small.rglob("*") if path.is_file()}
        seal = hashlib.sha256(json.dumps(sorted(original.items()), ensure_ascii=False,
                                         separators=(",", ":")).encode("utf-8")).hexdigest()
        require(frozen == original and material_seal(frozen) == seal, "Fingerprint or seal differs from baseline")
        require(changed_paths_from_fingerprint(frozen) == small_changed,
                "Fingerprint-derived changed paths differ from baseline")
        outside = root / "outside"
        outside.mkdir()
        (outside / "file.txt").write_text("external", encoding="utf-8")
        linked = small / "outside"
        try:
            linked.symlink_to(outside, target_is_directory=True)
        except OSError:
            require(os.name == "nt", "Could not create test symlink")
            from _winapi import CreateJunction
            CreateJunction(str(outside), str(linked))
            expect_invalid(lambda: fingerprint(small), "Reparse point")
            linked.rmdir()
        else:
            expect_invalid(lambda: fingerprint(small), "Symlink in case")
            expect_invalid(lambda: fingerprint(linked), "Symlink at case root")
            linked.unlink() if os.name != "nt" else linked.rmdir()
        require(fingerprint(small) == frozen, "Removing link changed the frozen material")
        print("PASS fingerprint and seal parity, changed paths, and link rejection")

        small_plan = build_review_plan(small, small_changed)
        byte_limit = small_plan.inline_diff_bytes
        small_plan = build_review_plan(small, small_changed, byte_limit)
        require(small_plan.shard_count == 1 and not small_plan.sharded and
                small_plan.omitted_files == ("binary.dat", "uv.lock") and
                "a1 | +new" in small_plan.shards[0].text and len(small_plan.shards[0].hunks) == 3,
                "Single-packet boundary lost source hunks or inlined an excluded file")
        check_launches(small, root / "small-output", small_plan, [lens[0] for lens in LENSES],
                       "standard", byte_limit)
        print("PASS single-packet coverage, three parallel lenses, and output contracts")
        check_parallel_verification(small, root / "parallel-verify", small_plan, small_changed)
        print("PASS module-partitioned parallel verification and merged output contracts")

        giant = root / "giant"
        giant_file = "src/large.go"
        giant_changed = make_review_fixture(giant, [
            (giant_file, ["old"] * 4, [str(index) + "x" * 43_000 for index in range(4)]),
            ("uv.lock", None, ["locked"]),
        ])
        giant_plan = build_review_plan(giant, giant_changed)
        expected = giant_plan.diffs[giant_file].annotated
        actual = [hunk.text for shard in giant_plan.shards for hunk in shard.hunks]
        require(giant_plan.sharded and giant_plan.shard_count == 2 and actual == expected and
                not giant_plan.omitted_files and not giant_plan.truncated_hunk_ranges and
                giant_plan.excluded_files == ("uv.lock",), "Giant file lost hunks or reordered them")
        require(all(shard.byte_count == len(shard.text.encode()) <= MAX_DIFF_BYTES for shard in giant_plan.shards),
                "Shard exceeds its recorded byte limit")
        giant_diff = giant_plan.diffs[giant_file]
        parts, outside = split_hunk(Hunk(giant_file, expected[0], len(expected[0].encode()), giant_diff.ranges[0]), 180)
        require(not outside and len(parts) == 2 and not parts[0].truncated and parts[1].truncated and
                "b1 | -old" in parts[0].text and "[part 2/2]" in parts[1].extent and
                all(part.byte_count <= 180 for part in parts),
                "Only the oversized source line should be truncated")
        zero = build_review_plan(giant, giant_changed, 0)
        require(zero.inline_diff_bytes == 0 and len(zero.omitted_hunk_ranges) == 4 and
                not zero.sharded and [stage[0] for stage in stage1_lenses(zero)] == [lens[0] for lens in LENSES],
                "A zero budget should omit all hunk ranges")

        added = root / "added"
        added_file = "ui/large.tsx"
        rows = [f"{index}:" + "é" * 80 for index in range(950)]
        added_changed = make_review_fixture(added, [(added_file, None, rows)])
        (added / "diff.patch").write_bytes((
            f"diff --git a/{added_file} b/{added_file}\n--- /dev/null\n+++ b/{added_file}\n"
            f"@@ -0,0 +1,{len(rows)} @@\n" + "".join(f"+{row}\n" for row in rows)
        ).encode("utf-8"))
        added_plan = build_review_plan(added, added_changed)
        parts = [part for shard in added_plan.shards for part in shard.hunks]
        original_rows = added_plan.diffs[added_file].annotated[0].split("\n")[1:]
        require(len(parts) == added_plan.shard_count == 2 and len(original_rows) == len(rows) and
                [row for part in parts for row in part.text.split("\n")[1:]] == original_rows and
                all(f"[part {index}/2] @@" in part.text.partition("\n")[0] and
                    part.byte_count == len(part.text.encode()) <= MAX_DIFF_BYTES
                    for index, part in enumerate(parts, 1)) and
                not added_plan.truncated_hunk_ranges and not added_plan.omitted_hunk_ranges and
                added_plan.rules_hunks == parts[0].text,
                "Giant hunk lost annotated lines or did not split cleanly for both packing paths")

        exact = root / "exact"
        exact_changed = make_review_fixture(exact, [
            (f"{module}/core.py", ["old"], ["x" * length])
            for module, length in (("alpha", 59_000), ("beta", 54_000), ("gamma", 42_000))
        ])
        exact_plan = build_review_plan(exact, exact_changed)
        require(exact_plan.shard_count == 2 and not exact_plan.omitted_hunk_ranges and
                1.28 < exact_plan.inline_diff_bytes / MAX_DIFF_BYTES < 1.32,
                "The 1.3-packet multi-module diff should fit in two shards")
        print("PASS line-aligned hunk splitting, oversized single lines, and exact-fit shard count")

        grouped = root / "grouped"
        grouped_changed = make_review_fixture(grouped, [
            ("alpha/one.py", ["old"], ["x" * 60]), ("alpha/two.py", ["old"], ["x" * 60]),
            ("beta/one.py", ["old"], ["x" * 60]), ("beta/two.py", ["old"], ["x" * 60]),
            ("docs/guide.md", ["old"], ["x" * 30]), ("tests/test_core.py", ["old"], ["x" * 30]),
            ("tests/fixtures/sample.txt", ["old"], ["x" * 30]),
        ])
        group_limit = 310
        grouped_plan = build_review_plan(grouped, grouped_changed, group_limit, 2)
        require([shard.files for shard in grouped_plan.shards] ==
                [["alpha/one.py", "alpha/two.py"], ["beta/one.py", "beta/two.py"]] and
                grouped_plan.omitted_files == ("docs/guide.md", "tests/fixtures/sample.txt", "tests/test_core.py") and
                "docs/guide.md" in grouped_plan.rules_hunks and "tests/test_core.py" in grouped_plan.rules_hunks and
                "tests/fixtures/sample.txt" not in grouped_plan.rules_hunks,
                "Directory affinity, tier priority or global rules selection differs")
        check_launches(grouped, root / "grouped-output", grouped_plan,
                       ["shard-1", "shard-2", "lens-contracts", "lens-rules-tests"], "ultra", group_limit, 2)
        print("PASS bounded hunk sharding, directory and tier packing, and ordered parallel ultra waves")

        renamed = root / "renamed"
        (renamed / "before").mkdir(parents=True)
        (renamed / "after").mkdir()
        (renamed / "before/old.py").write_bytes(b"first\r\nsecond\r\nthird\r\n")
        (renamed / "after/new.py").write_bytes(b"first\r\ninserted\r\nsecond\r\nthird\r\n")
        (renamed / "diff.patch").write_bytes(
            b"diff --git a/old.py b/new.py\n--- a/old.py\n+++ b/new.py\n"
            b"@@ -1,2 +1,3 @@\n first\r\n+inserted\r\n second\r\n")
        location_hint = {"file": "new.py", "line_start": 4, "line_end": 4}
        aligned = build_candidate_snippets(renamed, [location_hint], context_lines=0)
        require("after/new.py\n4: third" in aligned and "before/old.py\n3: third" in aligned and "\r" not in aligned,
                "Rename-aware CRLF excerpt alignment differs")
        for name in ("before/old.py", "after/new.py"):
            (renamed / name).write_bytes((("è" * 1_600 + "\r\n") * 60).encode("utf-8"))
        (renamed / "diff.patch").write_bytes(
            b"diff --git a/old.py b/new.py\nsimilarity index 100%\nrename from old.py\nrename to new.py\n")
        capped = build_candidate_snippets(renamed, [{**location_hint, "line_start": 30, "line_end": 30}])
        require(len(capped.encode("utf-8")) <= 48_000 and "before/old.py" in capped and "after/new.py" in capped and
                "[line truncated]" in capped and "[Source excerpts truncated" in capped,
                "Verifier excerpt byte cap, line truncation or pure rename alignment differs")
        print("PASS aligned rename-aware excerpts, verifier schema, and strict locations")


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
        parser.add_argument("--max-diff-bytes", type=int, default=MAX_DIFF_BYTES, help=f"Inline annotated diff budget per shard (default: {MAX_DIFF_BYTES})")
        parser.add_argument("--max-shards", type=int, default=MAX_SHARDS,
                            help=f"Maximum primary discovery shards (default: {MAX_SHARDS})")
        parser.add_argument("--serial-discovery", action="store_true", help="Run discovery lenses one at a time")
        try:
            main(parser.parse_args())
        except KeyboardInterrupt:
            print("Review interrupted: KeyboardInterrupt", file=sys.stderr)
            sys.exit(130)
        except Exception as error:
            print(f"Review interrupted: {error}", file=sys.stderr)
            sys.exit(1)
