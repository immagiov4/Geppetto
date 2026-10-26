---
name: code-review
description: "Review a branch, PR or local changes with an available verification runtime: independent searches, finding confirmation, coverage and measured usage. The default code-review procedure."
---

# Code review

Produce a report on an identified change, with findings supported by real paths, checked locations, coverage and limitations. Use the runtime selected during adoption or discover a suitable installed CLI, application or harness. The result is an assisted review of the change, with the evidence level stated for each finding.

Use this as the baseline code-review procedure. Fix sources and contract, run independent searches and verify each candidate before confirming it. Read [process execution](../geppetto-adopt/references/processes.md) before launching tools; the current task's model, service-tier and delegation restrictions govern invocation.

## Choose the review runtime

Inspect available programs and delegation interfaces, including Claude Code, Codex, Pi and OpenCode. Verify fresh-context execution, scoped access to review material, authentication, the requested model/options and retained outputs. Reuse the project's working invocation when present. Apply the independent searches, separate confirmation and reporting below through that runtime, retaining its actual invocation, results and available usage evidence.

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

The script selects `gpt-6.1-sol` with `-m`, sets `review_model` in the same process and uses `model_reasoning_effort=medium`. It verifies model and effort in session `turn_context` data. A different model, missing context or failed request stops the procedure. `--effort xhigh` requires `--effort-reason` and complexity justifying the authorized level.

`--ignore-user-config` keeps overrides within the run and reuses existing authentication. `--sandbox read-only` and `-a never` regulate reviewer tools. Instructions restrict reads to the case; read-only protection prevents writes but permits external reads. The coordinator checks transcripts for actual scope.

## Assess evidence

Run two searches in distinct sessions: contract and correctness; flows, regressions and security. The second receives the same material as the first. A third session retraces every candidate and returns `accept`, `reject` or `unverified`, with evidence and deduplication. Even with no candidates, retain reading limitations. The three calls run serially, retaining responses, available events and usage, actual model, duration and source identity. The bundled Codex runner records these in its output directory and freezes material fingerprints.

Check each candidate using [receive-work-feedback](../receive-work-feedback/SKILL.md): authoritative requirement, supported path, material consequence and evidence in the change. Reviewer agreement is a clue; code and observations support the decision. A contract ambiguity requires a maintainer decision. The review brief keeps sources read-only.

To confirm behaviour, run a lightweight reproduction in another copy and compare with the base. Coordinate expensive checks with the repository's gate owner. Distinguish static analysis, executed reproduction and visual verification. When proof remains open, keep the candidate with its limitation.

## Deliver the result

Use `report.md`, `findings.json` and `metrics.json`. Report location, severity, trigger, consequence, contract and evidence for each confirmed finding; retain decisions for every candidate, coverage and parts needing verification. Lines refer to `after`; for a deleted file absent from `after`, use source and lines from `before`. State the version beside the location. Every accepted canonical finding has its own self-referencing `accept` decision; other accepted candidates may refer to it. Preserve manifest `target`, `base` and `head` when available, and summarise recorded usage and the sum of serial call durations.

Check actual reads in events against claimed coverage. Recorded usage measures one run; an empty result describes only the scope and evidence actually reached.

For Qwen provenance and coverage differences, read [references/qwen-method.md](references/qwen-method.md). The process retains separate search and verification; a small test supports a judgment about that sample.
