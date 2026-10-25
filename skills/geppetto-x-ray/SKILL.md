---
name: geppetto-x-ray
description: "X-ray behaviour while building visibility. Use when designing a feature, changing error handling, diagnosing a failure or completing Observability."
---

# X-ray

Design visibility with the feature: what can be observed, where, at what detail and which paths remain blind. Name blind spots so a hypothesis remains distinct from a supported diagnosis. Trace the actual behaviour and invariants through meaningful events, durations and failures; provide enough original cause and context to explain a fault.

Errors surface explicitly. Preserve the original cause and context when adding an error boundary. A fallback retains evidence of the failure that activated it. A catch must not swallow an error or report success for a failed operation. Redact secrets and personal data through deterministic rules, or a local model when appropriate, while retaining the technical explanation. Keep internal diagnostic details in their authorized evidence location and user-facing messages at the project's safe boundary.

Agree the detail budget for this system: an anticheat and a business application need different visibility. A ring buffer with an error snapshot is one possible design, not a prescribed mechanism. Read `$geppetto-measure-it` before adding instrumentation to name benefit and overhead.

Each feature's owning document contains `## Observability`: behaviour and invariants, measurements and their reasons, events/errors, where to inspect evidence, blind spots and cost. Update that document only when a documented fact or observability surface changes. For a correction that restores the stated behaviour with the same evidence surfaces, record proof and limits in the PR/ticket `## Observability`; that section is the change record.

When the feature document needs an update, use its existing owner and the [feature template](../geppetto-adopt/assets/templates/feature-doc.md). An index may link pages; keep declarations beside their feature. Add `## Verification` when configured for significant tests. Run `.geppetto/bin/gate-sections.mjs --docs <changed-doc-paths> --config .geppetto/config.json`; a heading passes structurally only with content, while the declaration's meaning still needs review. Complete when each affected declaration matches the actual evidence and limits, or the PR/ticket records the implementation-only correction.
