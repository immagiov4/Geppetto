# Changelog

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
