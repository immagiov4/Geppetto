---
name: geppetto-x-ray
description: "Design technical observability in every specification and implement diagnostic access with the feature. Use to inspect normal operation, state, duration, failure or interruption across system and component boundaries."
---

# X-ray

If `~/.geppetto/integrations.md` has a section for this skill, read it.

Design technical observability in every specification before implementation: inspect running code, infrastructure and dependencies. Follow `foundations.observability` in `.geppetto/config.json`. When unset, compare approaches WITH the user through `$geppetto-spec`, record the choice and reuse it.

Answer the maintainer's diagnostic questions:

- **System:** what is running, available, waiting or making progress; which dependencies and resources explain its condition?
- **Operation:** which request or job is this, what path and state transitions did it take, how long did they take, and what happened on retry, cancellation or restart?
- **Component:** which invariant, input boundary or dependency explains the result; where can the maintainer query its traces, events, metrics or diagnostics?

Use the levels relevant to the change and connect them through operation identity and component ownership. Cover successful operation and intermediate states as well as failures. Reuse existing diagnostics when they answer these questions; state the remaining blind spots. Test the design with a representative normal operation and an interrupted or failed one, showing how someone locates and explains each through the agreed tools.

Choose detail for the context of use. Budget volume and performance through sampling, levels, rotation and retention; verify collection and access across supported environments. Read `$geppetto-measure-it` before instrumentation to establish benefit and overhead.

Preserve error causes and context. Recoveries retain evidence of what failed; failure must remain distinguishable from success. Keep private data and secrets out of logs, applying redaction at collection boundaries. Store technical diagnostics in their authorized location and present stable messages at the user boundary.

Explain the approach in the specification's `## Observability`: technical views and linked identities, behavior and invariants, measurements and rationale, collection/query access, privacy, volume controls, overhead and blind spots. The feature document retains the evolving design. A specification may be an agreed conversation or local artifact; a Git host is optional. A PR/ticket reports implementation evidence and links this owner. A correction records whether the existing design still answers the diagnostic questions.

Use the existing document and [feature template](../geppetto-adopt/assets/templates/feature-doc.md). Keep declarations beside the feature; indexes link them. Add Verification when configured for significant tests. Run `<adopt>/scripts/gate-sections.mjs --docs <changed-doc-paths> --config .geppetto/config.json`; headings establish structure, while a reader assesses meaning. Complete when declarations match demonstrated behaviour and limits.

## Agent tool observability

Start with authorized harness session records and existing archives. Identify actual recorded fields: call identity, tool, duration and outcome. Report gaps; distinguish invocation errors, permission denials and executed commands with failing exits. Summarize counts and durations deterministically and retrieve detailed events for diagnosis.

Propose native OpenTelemetry only for an identified gap. Inspect existing exporters, destinations and managed configuration first; prefer read-only archive queries. Preserve existing flows when adding a destination through collector outputs. Establish the file, API, CLI or MCP access the agent needs to query collected data. Reuse storage and retention controls before adding collection machinery. Available history bounds the analysis; export cannot recover unrecorded events.
