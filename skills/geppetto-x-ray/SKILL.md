---
name: geppetto-x-ray
description: "X-ray behaviour while building visibility. Use when designing a feature, changing error handling, diagnosing a failure or completing Observability."
---

# X-ray

If `~/.geppetto/integrations.md` has a section for this skill, read it.

Follow `foundations.observability` in `.geppetto/config.json`. Before creating telemetry with it unset, use `$geppetto-spec` to compare concrete approaches and decide WITH the user. Record the choice and reuse it.

Design realistic visibility for the context of use: observed behaviour, invariants, failures, durations and blind spots. An anticheat and a business application need different detail. Budget volume and performance through appropriate sampling, levels, rotation and retention; verify collection and access across supported environments. Read `$geppetto-measure-it` before instrumentation to establish benefit and overhead.

Preserve error causes and context. Recoveries retain evidence of what failed; failure must remain distinguishable from success. Keep private data and secrets out of logs, applying redaction at collection boundaries. Store technical diagnostics in their authorized location and present stable messages at the user boundary.

Explain the approach to a human in the feature document's `## Observability`: behaviour and invariants, measurements and rationale, collection/access, privacy, volume controls, overhead and blind spots. Update that owner when its contract changes. A correction restoring the same behaviour and evidence surfaces records proof and limits in the PR/ticket's Observability section.

Use the existing document and [feature template](../geppetto-adopt/assets/templates/feature-doc.md). Keep declarations beside the feature; indexes link them. Add Verification when configured for significant tests. Run `<adopt>/scripts/gate-sections.mjs --docs <changed-doc-paths> --config .geppetto/config.json`; headings establish structure, while a reader assesses meaning. Complete when declarations match demonstrated behaviour and limits.

## Agent tool observability

Start with authorized harness session records and existing archives. Identify actual recorded fields: call identity, tool, duration and outcome. Report gaps; distinguish invocation errors, permission denials and executed commands with failing exits. Summarize counts and durations deterministically and retrieve detailed events for diagnosis.

Propose native OpenTelemetry only for an identified gap. Inspect existing exporters, destinations and managed configuration first; prefer read-only archive queries. Preserve existing flows when adding a destination through collector outputs. Establish the file, API, CLI or MCP access the agent needs to query collected data. Reuse storage and retention controls before adding collection machinery. Available history bounds the analysis; export cannot recover unrecorded events.
