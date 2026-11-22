---
name: code-review
description: "Review a branch, PR or local changes with an available verification runtime: independent searches, finding confirmation, coverage and measured usage. The default code-review procedure."
---

# Code review

Produce a report on an identified change, with findings supported by real paths, checked locations, coverage and limitations. Use the runtime selected during adoption or discover a suitable installed CLI, application or harness. The result is an assisted review of the change, with the evidence level stated for each finding.

Start with three independent review lenses and verify their candidates in a fresh session. Use the question-based or generic strategy for explicit requests and comparisons. Read [process execution](../geppetto-adopt/references/processes.md) before launching tools; the current task's model, service-tier and delegation restrictions govern invocation.

## Choose the review runtime

Inspect available programs and delegation interfaces, including Claude Code, Codex, Pi and OpenCode. Verify fresh-context execution, scoped access to review material, authentication, the requested model/options and retained outputs. Reuse the project's working invocation when present. Apply the independent searches, separate confirmation and reporting below through that runtime, retaining its actual invocation, results and available usage evidence.

This procedure calls for independent reviewers in fresh contexts through the permitted delegation interface or runner. Use the task's authorized model and settings unless a separate reviewer selection was approved; a runner's default model is not a requirement to switch models. Preserve explicit prohibitions on delegation and distinguish them from a harness rule that permits delegation when a skill requests it.

The bundled Python runner automates the Codex invocation. For another runtime, use its existing execution or delegation interface with the same isolated material and review stages.

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

- `--strategy lenses` is the default. `--profile standard` runs three independent discovery lenses in parallel. `--profile ultra` adds two parallel gap searches for large or high-risk changes. Both profiles send candidates to a skeptical verifier with numbered source excerpts.
- `--effort {low,medium,high,xhigh}` sets discovery effort (default `medium`). `--verify-effort` defaults to `high` for lenses and follows `--effort` for the other strategies. `--gap-effort` defaults to `medium` for the ultra gap searches. Any active `xhigh` setting requires `--effort-reason` and an authorized rationale.
- `--max-diff-bytes` caps the inline annotated diff at 90,000 bytes by default. The case packet names omitted files for direct inspection. `--serial-discovery` runs discovery lenses one at a time.
- `--strategy questions` runs question generation and investigation. `--strategy generic` runs two independent searches. Both run serially and use a separate confirmation session when candidates exist.
- `--tool-budget` defaults to 16 instructed calls per session for lenses and 24 for the other strategies. `--timeout-seconds` enforces the process deadline for each session; size it generously (for example, 600–900 seconds, or higher on large diffs and `ultra`) so it catches stalled processes rather than aborting a nearly finished stage and discarding prior stage work.

`--ignore-user-config` keeps overrides within the run and reuses existing authentication. `--sandbox read-only` and `-a never` regulate reviewer tools. Instructions restrict reads to the case; read-only protection prevents writes but permits external reads. The coordinator checks transcripts for actual scope.

## Assess evidence

For `lenses`, give each discovery session the same frozen case, contract excerpt, changed-file index and line-numbered diff. Assign one lens to failing inputs and branches, one to cross-file contracts and lifecycle, and one to rules, documentation, tests and UI. In `ultra`, give two additional sessions the first-round candidate summary and changed paths without findings. One revisits logic and transitions. The other checks remaining contracts, documentation and test oracles.

For `generic`, run two searches in distinct sessions with the same material. One examines contract and correctness. The other examines flows, regressions and security.

For `questions`, the first fresh session reads the change and relevant consumers, producing up to 20 concrete questions without padding or asserting defects. Each gives a source anchor, observed fact, question, evidence needed and relationship examined. The second fresh session receives the same case, every valid question and the ordinary review brief. Questions are leads, not proof. Follow the value, error or readiness condition through handoffs to its effective consumer or observable outcome. Forwarding it intact does not settle downstream behavior. For regressions compare the previously successful path with the target, including reused results and fast returns. Account for each question as `reported`, `no_issue`, `suspected_unverified` or `not_examined`, with checked sources and the last checked consumer. A necessary untraced handoff stays uncertain or unexamined. Material test defects require a concrete assertion or fixture blind spot. Retain public source observations, not private reasoning transcripts. Keep ordinary findings separate from question dispositions.

When candidates exist, a fresh session independently checks each one against source and contract. In `lenses` it receives candidate excerpts and tries to disprove attribution to the change, reachability, material consequence and violation of intent. Return `accept`, `reject` or `unverified` for every candidate ID. Deduplicate only when cause, trigger and consequence match. Retain reading limitations even when discovery produces no candidates. The runner preserves prompts, responses, events, usage and source identity, and stops on invalid output, timeout or changed material with partial evidence and no final report.

Check each candidate using [receive-work-feedback](../receive-work-feedback/SKILL.md): authoritative requirement, supported path, material consequence and evidence in the change. Reviewer agreement is a clue; code and observations support the decision. A contract ambiguity requires a maintainer decision. The review brief keeps sources read-only.

To confirm behaviour, run a lightweight reproduction in another copy and compare with the base. Coordinate expensive checks with the repository's gate owner. Distinguish static analysis, executed reproduction and visual verification. When proof remains open, keep the candidate with its limitation.

## Deliver the result

Use `report.md`, `findings.json` and `metrics.json`. Report location, severity, trigger, consequence, contract and evidence for each confirmed finding; retain decisions for every candidate, coverage and parts needing verification. Lines refer to `after`; for a deleted file absent from `after`, use source and lines from `before`. State the version beside the location. Every accepted canonical finding has its own self-referencing `accept` decision; other accepted candidates may refer to it. Preserve manifest `target`, `base` and `head` when available, and summarise recorded usage and elapsed review time and summed session durations.

Check actual reads in events against claimed coverage. Recorded usage measures one run; an empty result describes only the scope and evidence actually reached.

During parallel discovery, `metrics.json` lists each stage as `running` at launch and updates it as it finishes, retaining lens order for both calls and known session IDs. On interruption, check `status` and `failure` for the review and its incomplete stages.

The question strategy also retains `questions.json`, `investigate.json` and `triage.json`. The final report lists each disposition and its last consumer, including unresolved questions in limitations. `metrics.json` records the strategy, profile, `parallel_discovery`, budgets, `candidate_count` and per-stage status. Inspect `wall_seconds` for elapsed review time, `totals.elapsed_seconds` for summed session time, and `totals.usage` for recorded tokens. For lenses, `inline_diff_bytes` and `inline_diff_omitted_files` describe the inline evidence sent to discovery. `report.md` lists any verifier observations under **Additional observations (unverified)**. Confirmed findings come from the verifier's accepted candidates. Dollar cost is unknown unless independently available. Source anchors and complete accounting are checked mechanically; whether a claimed consumer actually settles the question still requires source review.

When this procedure is the configured review engine, use the contextual Stop command with `--evidence <output>` after review completes and before editing findings. Preserve runner artifacts and use `git diff --binary --no-ext-diff <base> --` for the tracked patch, with all relevant untracked files in `after/` and the manifest. The [review gate](../geppetto-adopt/assets/templates/hooks/README.md#review-gate) owns the record contract. For a constrained-session self-review, retain `independent review pending` and state `Independent review blocked: <concrete reason>` in the reply.

For Qwen provenance and coverage differences, read [references/qwen-method.md](references/qwen-method.md). The process retains separate search and verification; a small test supports a judgment about that sample.
