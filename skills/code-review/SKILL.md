---
name: code-review
description: "Review a branch, PR or local changes with an available verification runtime: independent searches, finding confirmation, coverage and measured usage. The default code-review procedure."
---

# Code review

Produce a report on an identified change, with findings supported by real paths, checked locations, coverage and limitations. Use the runtime selected during adoption or discover a suitable installed CLI, application or harness. The result is an assisted review of the change, with the evidence level stated for each finding.

Start with independent discovery and verify its candidates in fresh sessions. Use the question-based or generic strategy for explicit requests and comparisons. Read [process execution](../geppetto-adopt/references/processes.md) before launching tools; the current task's model, service-tier and delegation restrictions govern invocation.

## Choose the review runtime

Inspect available programs and delegation interfaces, including Claude Code, Codex, Pi and OpenCode. Verify fresh-context execution, scoped access to review material, authentication, the requested model/options and retained outputs. Reuse the project's working invocation when present. Apply the independent searches, separate confirmation and reporting below through that runtime, retaining its actual invocation, results and available usage evidence.

This procedure calls for independent reviewers in fresh contexts through the permitted delegation interface or runner. Use the task's authorized model and settings unless a separate reviewer selection was approved; a runner's default model is not a requirement to switch models. Preserve explicit prohibitions on delegation and distinguish them from a harness rule that permits delegation when a skill requests it.

The bundled runner automates the Codex invocation and requires Python 3.11 or newer. For another runtime, use its existing execution or delegation interface with the same isolated material and review stages.

## Constrained-session handoff

When no independent reviewer is available within current tools or task restrictions, inspect the identified diff against its contract, callers and applicable lenses yourself. Deliver current-revision checks, candidate dispositions and coverage as **self-review**, with the named gap **independent review pending** and its reason. This completes the constrained-session evidence handoff; any integration requirement for independent review remains pending. Use the independent procedure below when a permitted reviewer becomes available.

## Fix the material

1. Identify the contract from the maintainer's brief, approved decisions and issue. Read applicable `AGENTS.md` instructions. For a remote repository, compare the available revision with `git ls-remote`; record the revision actually examined. Material needs a repeatable identity. Without a specification, use the brief and documented invariants, recording undetermined requirements.
2. Prepare an isolated directory outside the repository with `before/`, `after/`, `diff.patch`, `contract.md` and `manifest.json`. For fixed Git revisions use `git archive` and `git diff --binary --no-ext-diff`. For a PR, use its actual merge-base. For local changes capture tracked, modified and relevant new files, preserving comparison with HEAD. Directories contain sources and instructions; exclude credentials and dependencies.
3. Put `target`, `changed_files` as paths relative to the two versions, and revision identities when available in the manifest. Check that patch and manifest represent every file difference. The contract also records decisions overriding repository instructions. Keep expected evidence and prior results outside reviewer material.

The automated check compares the manifest with changed files and freezes fingerprints of all material before calls. Git comparison accuracy and contract authority remain the coordinator's responsibility.

## Codex runner

Read `codex --version`, `codex exec --help` and `codex login status`. Use the available authenticated CLI. Obtain maintainer authorization for any needed update. On Windows locate the actual `codex.exe` behind the npm launcher; `--codex` takes that path. Verify version and authentication without printing credentials. Use official documentation when CLI behaviour changes.

Resolve `$reviewSkill` from this `SKILL.md` directory, including plugin installations. Run `scripts/run_review.py --help`, then supply the case directory, a new output directory outside the case, the CLI path and a per-call time limit consistent with the brief through `--timeout-seconds`.

```powershell
python "$reviewSkill/scripts/run_review.py" `
  --case $reviewCase --output $reviewOutput --codex $codexExe `
  --timeout-seconds $reviewTimeoutSeconds
```

If applicable instructions request another model, record the authorized decision resolving the conflict in the contract before starting the CLI. A prohibition on delegation or a fixed model/effort remains binding; report incompatibility rather than overriding it.

The default model is `gpt-6.2-sol`. Use `--model <model>` to select the authorized model. The runner verifies the effective model and effort in session `turn_context` data. A mismatch, missing context or failed request stops the run.

- `--strategy lenses` is the default. Both profiles run primary discovery, then share its candidate and coverage summary with a second wave. `--profile standard` uses one gap search. `--profile ultra` uses two specialized gap searches. The sessions in each wave run in parallel by default.
- `--effort {low,medium,high,xhigh}` sets discovery effort (default `medium`). `--verify-effort` defaults to `high` for lenses and follows `--effort` for the other strategies. `--gap-effort` defaults to `medium` for the second discovery wave. Any active `xhigh` setting requires `--effort-reason` and an authorized rationale.
- `--max-diff-bytes` limits the inline annotated diff to 120,000 bytes per packet by default. `--max-shards` caps primary discovery at five shards by default. Use `--max-shards 1` to keep a single packet. `--serial-discovery` runs discovery one session at a time and uses a single verifier.
- `--strategy questions` runs question generation and investigation. `--strategy generic` runs two independent searches. Both run serially and use a separate confirmation session when candidates exist.
- `--tool-budget` defaults to 16 instructed calls per session for lenses and 24 for the other strategies. `--timeout-seconds` enforces the process deadline for each session; size it generously (for example, 600–900 seconds, or higher on large diffs and `ultra`) so it catches stalled processes rather than aborting a nearly finished stage and discarding prior stage work.

`--ignore-user-config` keeps overrides within the run and reuses existing authentication. `--sandbox read-only` and `-a never` regulate reviewer tools. Instructions restrict reads to the case; read-only protection prevents writes but permits external reads. The coordinator checks transcripts for actual scope.

## Assess evidence

For `lenses`, give each session the same frozen case, contract excerpt and changed-file index. A single packet goes to `lens-correctness` for failing inputs, branches and cross-file contracts, and to `lens-rules-tests` for repository rules, documentation, tests and UI. When several packets are needed, split oversized hunks at source-line boundaries, group by priority and directory, and give each `shard-1` through `shard-K` its assigned hunks and related source.

Each packet includes a bounded static map from changed symbols to likely callers, sibling handlers and state references in `after/`. It skips generic names, comment-only changes, prose files and generated deepcopy files during symbol lookup. Use it to find source to verify, and read omitted or truncated ranges directly when relevant.

Wave 2 starts with Wave 1 candidates, uncovered hunks and caller sites. Follow those leads to new defects and leave already reported root causes to verification. Uncovered hunks rotate across files, in priority and path order, before the 60-entry summary cap and before filling the sharded gap packet. With one packet, standard uses `gap-audit` and ultra uses `gap-logic` and `gap-contracts-docs`. With several packets, standard uses `gap-audit` for cross-shard behaviour, rules and tests. Ultra splits that work between `gap-seams` and `gap-rules-tests`.

For a claim about a runtime or standard-library API, option, regex or pure expression, use a short read-only probe with synthetic inputs when the runtime is available. Run it inline or through stdin, disable bytecode or cache writes, and keep project imports, project execution and network access outside the probe.

For `generic`, run two searches in distinct sessions with the same material. One examines contract and correctness. The other examines flows, regressions and security.

For `questions`, the first fresh session reads the change and relevant consumers, producing up to 20 concrete questions without padding or asserting defects. Each gives a source anchor, observed fact, question, evidence needed and relationship examined. The second fresh session receives the same case, every valid question and the ordinary review brief. Questions are leads, not proof. Follow the value, error or readiness condition through handoffs to its effective consumer or observable outcome. Forwarding it intact does not settle downstream behavior. For regressions compare the previously successful path with the target, including reused results and fast returns. Account for each question as `reported`, `no_issue`, `suspected_unverified` or `not_examined`, with checked sources and the last checked consumer. A necessary untraced handoff stays uncertain or unexamined. Material test defects require a concrete assertion or fixture blind spot. Retain public source observations, not private reasoning transcripts. Keep ordinary findings separate from question dispositions.

When candidates exist, independently check each one against source and contract. Use aligned before/ and after/ excerpts and look for guards, callers or fixtures that defeat attribution, reachability or material consequence. Return `accept`, `reject` or `unverified` for every candidate ID. Consolidate findings with the same demonstrated root cause and preserve each verified trigger and consequence. The verifier groups nearby candidate locations in each file so it can compare their causes against the same source. With more than 12 candidates and parallel discovery enabled, `lenses` uses `verify-1` and `verify-2` when it can form two batches of at least four candidates. It keeps top-level modules intact where a valid split exists and keeps each file intact in every split. Candidates in different batches are checked independently. Use `--serial-discovery` for global deduplication in a single verifier session when the same defect may appear in different modules. All other runs use one `verify` session.

Retain reading limitations even when discovery produces no candidates. The runner preserves prompts, responses, events, usage and source identity. A failed stage or changed material at a wave boundary leaves partial evidence and no final report.

Check each candidate using [receive-work-feedback](../receive-work-feedback/SKILL.md): authoritative requirement, supported path, material consequence and evidence in the change. Reviewer agreement is a clue; code and observations support the decision. A contract ambiguity requires a maintainer decision. The review brief keeps sources read-only.

To confirm behaviour, run a lightweight reproduction in another copy and compare with the base. Coordinate expensive checks with the repository's gate owner. Distinguish static analysis, executed reproduction and visual verification. When proof remains open, keep the candidate with its limitation.

## Deliver the result

Use `report.md`, `findings.json` and `metrics.json`. When verification runs, `verification.json` contains its complete response. Parallel verification also retains each original response in `verify-1.json` and `verify-2.json`. Report location, severity, trigger, consequence, contract and evidence for each confirmed finding; retain decisions for every candidate, coverage and parts needing verification. Lines refer to `after`; for a deleted file absent from `after`, use source and lines from `before`. State the version beside the location. Every accepted canonical finding has its own self-referencing `accept` decision; other accepted candidates may refer to it. Preserve manifest `target`, `base` and `head` when available, and summarise recorded usage and elapsed review time and summed session durations.

When this procedure is the configured review engine, use the contextual Stop command with `--evidence <output>` after review completes and before editing findings. Preserve runner artifacts and use `git diff --binary --no-ext-diff <base> --` for the tracked patch, with all relevant untracked files in `after/` and the manifest. Each native Codex archive for a sharded review also binds the declared count with `Review shards: <K>` immediately after the stage line. The [review gate](../geppetto-adopt/assets/templates/hooks/README.md#review-gate) owns the record contract. For a constrained-session self-review, retain `independent review pending` and state `Independent review blocked: <concrete reason>` in the reply.

## Observability

Check actual reads in events against claimed coverage. Recorded usage measures one run; an empty result describes only the scope and evidence actually reached.

During parallel discovery and verification, `metrics.json` lists each stage as `running` at launch and updates it as it finishes. Calls and known session IDs stay in planned order. On interruption, check `status` and `failure` for the review and its incomplete stages.

The question strategy also retains `questions.json`, `investigate.json` and `triage.json`. The final report lists each disposition and its last consumer, including unresolved questions in limitations. `metrics.json` records the strategy, profile, `parallel_discovery`, budgets, `candidate_count` and per-stage status. Inspect `wall_seconds` for elapsed review time, `totals.elapsed_seconds` for summed session time, and `totals.usage` for recorded tokens. `prep_seconds` measures case fingerprinting and packet preparation. For lenses, `shard_count` and `shards` record each primary packet's files, hunk count and bytes. `symbol_context_bytes` and `symbol_context_count` report the global symbol section size and number of reference sites, and `symbol_scan_limited` marks a scan that reached its time limit. `uncovered_hunk_count` reports the total Wave 1 gap ranges before the summary cap. `inline_diff_bytes` totals the primary packets. Compare `inline_diff_omitted_files` and `inline_diff_omitted_hunk_ranges` with `inline_diff_excluded_files` (lockfiles or paths without text hunks) and `inline_diff_truncated_hunk_ranges` to see where direct reads are needed. `report.md` lists any verifier observations under **Additional observations (unverified)**. Confirmed findings come from the verifier's accepted candidates. Dollar cost is unknown unless independently available. Source anchors and complete accounting are checked mechanically; whether a claimed consumer actually settles the question still requires source review.

For Qwen provenance and coverage differences, read [references/qwen-method.md](references/qwen-method.md). The process retains separate search and verification; a small test supports a judgment about that sample.
