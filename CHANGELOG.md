# Changelog

## 0.22.0

- Run semantic screening as part of substantial requirements maps and retain a disposition for each attempt. Select the newest compatible Perplexity Decider through the OpenRouter Decisions catalog, with a daily cache and an explicit model override.
- Configure source sharing once at user scope or override it per project. A verified public GitHub origin supplies the default when neither is set. Startup and audit report unresolved source sharing.
- A workaround lesson records its resource costs and the follow-up for the underlying issue.
- Migration: update both plugins and reapprove Codex hooks. Use the screen command to record the existing user choice when startup or audit reports it unset.

## 0.21.0

- Weekly skill curation saves per-project metrics reports with operation times, storage, PR cycle, recorded overhead and up to two proposed experiments.
- SessionStart links to a report more than eight days old. The metrics audit reports observed reads.
- Migration: update both plugins and reapprove Codex hooks. The existing curation schedule is reused.

## 0.20.0

- Require a complete foundation decision record and a matching independent review result. Keep edit decisions active when the Stop review gate is disabled.
- Report installation drift for the running harness, including missing Codex trust and stale Windows task registrations. Older release caches no longer advertise a downgrade.
- Count anomalous operations separately from reminders, require evidence for a diagnosis and include structured GitHub PR results. The metrics audit reports errors and unknown gate coverage.
- Migration: update both plugins and reapprove Codex hooks. The contextual review recorder requires output artifacts. Previously recorded reviews remain in the journal, and earlier ADRs can be expanded using the turn record format.

## 0.19.0

- Mention unusual operation durations once per key and turn. Explicit expectations and approved thresholds take precedence over observed timings and cold-start floors.
- Keep diagnoses and efficiency signals beside their timing evidence. Summarize elapsed time, recorded reviews and unusual operations after a successful GitHub PR creation or merge.
- Migration: update both plugins and reapprove the Codex hooks. Existing timing rows remain readable and no new thresholds are installed.

## 0.18.0

- Codex requires the outstanding decision, review or learning outcome on retries. A recorded and explained override is scoped to the current decision epoch.
- Join new operation, decision and hook evidence by machine, harness, session, turn and epoch. The metrics audit reports unchecked edits, unresolved Stops and retries for each machine and harness.
- Migration: update the installed plugins and reapprove Codex hooks through the installer. Existing journal rows remain readable and may lack identity fields.

## 0.17.0

- Use the update checker to compare the published release with your installation. Adopted projects surface stale version information at session start.
- Migration: refresh the installed marketplace and plugin, then reconcile the project to refresh the launcher, maintenance registrations and CI pin. Reapprove Codex hooks through the installer and verify them in a fresh session.

## 0.16.0

- Discuss and record foundational design choices before implementation. The edit gate keeps a declared pending foundation blocked until a configuration decision or an architectural decision record is available.
- Design shared diagnostics up front, then add feature views to that shared design.
- Migration: update the installed plugin or generated skills to receive the decision checks. Existing configuration choices carry forward.

## 0.15.0

- Publish memory commits to their Git remote as soon as they are saved. Preserve existing commit hooks and report any push failure with recovery instructions.

## 0.14.0

- Record available and total disk space, Git worktree count and resident memory of new processes at Stop.
- Include bounded disk-size measurements and weekly comparisons in the metrics audit and curation context. Show merged pull request size beside cycle time.

## 0.13.0

- Record elapsed time for selected commands and delegation calls in the project journal. Use `audit.mjs --metrics` to compare timings, find decision waits, and inspect merged pull request cycle times.

## 0.12.3

- Record Windows maintenance startup errors when the launcher cannot start Node.

## 0.12.2

- Record weekly maintenance outcomes even when startup fails, and skip missing project paths.
- Register linked worktree installations under their main checkout for weekly maintenance.

## 0.12.1

- Before opening a pull request, record whether its body includes Inspectability and why. Use the existing work log or the conversation. The same step applies across publishing tools.

## 0.12.0

- Design and report Inspectability when a change introduces or alters behaviour. The specification describes how to inspect its state and diagnose failures, and the pull request points to the checks or diagnostics that make that possible.
- Omit Inspectability for changes that preserve behaviour. Include Testing when the checks or results help the reviewer assess the change.
- New Geppetto configurations no longer require an Observability heading in every pull request. Existing projects can remove that heading from `sections.pr` and update their PR templates and instructions together.

## 0.11.1

- Learning reminders and eligible signals reach the working session at the next tool result. Stop no longer returns that context, which Codex reported as a failed Stop hook and Claude Code ignores.

## 0.11.0

- Learning happens in the working turn. When the user is frustrated by the work, the agent closes it before the turn ends: it edits the owning rule (lesson), names the rule that already covers it (covered), explains why it cannot recur (one-off), or names the owner it cannot edit (blocked, which opens a signal). Stop asks once when the outcome is missing or a lesson's file did not change.
- Signals the agent records itself are offered to the working session once they reach the session threshold, and close through the same outcomes. A signal can be closed by hand with a reference and a reason.
- Stop no longer starts a background learning process. Learning branches, worktrees, delivery notices and the learning lock are gone; the weekly skill curation keeps merging duplicate signals and pruning skills. Updating removes a leftover `learn.lock` and temporary integration files; existing `geppetto/learn-*` branches and worktrees stay for review.

## 0.10.9

- Complete reviews with no candidates without an unnecessary verification model call, retaining coverage and limitations. Candidate findings still require independent confirmation.

## 0.10.8

- Make the independent-review request explicit when the host permits skill-requested delegation, while preserving explicit prohibitions.
- Require the local-fix route to read and execute the verification procedure instead of leaving the handoff implicit.

## 0.10.7

- Limit the global review gate to projects with a Geppetto configuration.
- Restrict requirements mapping to substantial software product changes; exclude tiny local edits and unrelated research or prose work.

## 0.10.6

- Remind the agent to consider reusable lessons after recorded feedback or frustration, even in short turns.

## 0.10.5

- Coordinate learning-state reads with the existing session lock so Windows state replacement does not race an open reader.
- Remove only owned JSON temporaries after failed publication, allowing recovery in the same process.

## 0.10.4

- Keep review findings anchored in unchanged consumers eligible for separate confirmation, while validating source paths and line ranges.

## 0.10.3

- Preserve parent-turn assessments and transcript cursors while subagents run in the same session, avoiding repeated full transcript reads on return.
- Resolve explicit turn recording and learning signals against their own saved state.
- Preserve learning qualification and background transcript cursors across alternating turns; report resumed transcript reads.
- Pair archived transcript positions with their source paths, keeping parent and subagent calibration evidence separate.

## 0.10.2

- Recognize user messages received during an active native turn before the next edit, and attribute learning signals to their current user assessment.
- Read appended transcript records through a local cursor, preserving separate handling for tool results and review feedback.
- Keep learning reminders eligible for qualifying steering messages within the same native turn.

## 0.10.1

- Complete authorized memory updates with commits and remote synchronization, including scheduled maintenance; preserve explicitly local-only delivery.

## 0.10.0

- Make question generation followed by investigation the default code-review strategy across runtimes and the CLI; retain the generic strategy for explicit requests and comparisons.

## 0.9.0

- Add a selectable question-generation and investigation strategy to code review, followed by independent finding confirmation.
- Retain source-anchored questions, complete dispositions, stage progress and failure evidence alongside the existing review report.

## 0.8.5

- Record background-learning attempts that are waiting for eligible evidence in the existing journal.

## 0.8.4

- Copy only Markdown companion guides when installing the integration catalog, leaving unrelated working files in the source checkout.

## 0.8.3

- Deliver retained background learning commits through internal tool context so the working session can verify and integrate them.
- Preserve pending proposals across later runs and record integration decisions separately for each checkout.

## 0.8.2

- Let background learning inspect redacted session messages, successful tool results and project configuration through its existing read-only file capability.
- Keep additional context in indexed pages loaded on demand; report missing sources and preserve the project-only write boundary.

## 0.8.1

- Record learning verification before editing, based on the actual scope of shared defaults and cross-cutting changes.
- Preserve concrete affected and unchanged behavior cases with the execution blocker when checks cannot run.

- Use existing task authority for temporary outcome checks; require approval for new standing metrics and acceptance policies.

## 0.8.0

- Add proportionate evaluation design guidance for behavioural improvements and learning.
- Finalize Codex hook approval after installation writes, preserving unrelated hooks and reporting blocked approval with a retry command.

## 0.6.0

- Personal memory buckets follow the same retrieval, maintenance and learning rules as other buckets; the name private does not block access or discard conversations.
- Independent reviews from any runtime can be recorded before small finding fixes.
- Turn decisions route first documentation and diagnostics to foundation choices.

- Installation explains capability choices and their data destinations, and reports the saved choices and controls.
- The semantic source screen uses the recorded `screen.shareSource` answer for private projects and projects without a remote.

## 0.5.3

- Learning records, evidence and progress live in the Git common directory, so every worktree of a repository shares them and they survive worktree removal. Old per-worktree records are imported once; originals stay untouched.

## 0.5.2

- Git output in large repositories no longer fails on buffer limits.

## 0.5.1

- Integration catalog: correct the skill-diet source and description, add install commands for ponytail, drop disclaimer sentences.

## 0.5.0

- Record documentation and observability foundations with the user, report unset choices and preserve agreed structure and realistic collection controls.

- Group learning evidence by stable keys and distinct sessions, with immediate action on flagged user feedback and configurable agent thresholds.
- Record one ordered, configurable problem category per episode, preserve secondary effects as attributes and retain legacy metric values as historical evidence.
- Link learning changes to evidence, retain unresolved occurrences and report recurrence and changed pages without observed reads.
- Log local skill/memory reads and compile installed companion guidance for each Geppetto skill, with a portable catalog and evidence-backed maintenance proposals.


## 0.4.0

- Decide requirements, incoming feedback and frustration before native file edits or after observed shell changes, with configurable questions and skills; edit-free turns close without a decision request.
- Renew feedback decisions after configured review-result commands and report measured decision delays and classified next-message corrections through audit.
- Keep tools available on hook errors, parse review-command arguments and help requests, and start fresh when active turn state has an incompatible shape.
- Use Liquid D1.1 for semantic requirements screening alongside lexical search and caller reading, with bounded recovery from HTTP 503 responses.

## 0.3.1

- Resolve maintenance jobs from the newest installed plugin cache at runtime, preserve scheduler registrations through updates and expose a dry run that checks job sources without executing maintenance.

## 0.3.0

- Run project CI from an immutable Geppetto package and migrate installed targets while preserving local edits and unrelated staged work. Fresh clones can update generated CI pins.
- Keep semantic requirements screening in its owning skill and remove automatic skill selection and memory classification.
- Record explicit turn decisions, combine their completion check with independent review, and learn from new transcript evidence. SessionStart supplies the recording command and schema before the first turn.
- Exclude private memory and redact secrets from learner evidence, close Stop safely on hook errors, and fingerprint large diffs through streamed Git output.
