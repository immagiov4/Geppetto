# Requirements map

## Outcome

Adopt Geppetto in its own repository, then extend optional memory classification from bucket/page selection to recursive index traversal. Selected sibling branches can run in parallel, and request payloads are split against an explicitly configured request-size budget. The default remains disabled until the existing benchmark/keep decision.

## Surfaces and lifecycle

Source baseline: 2c974963e1a6a0b02b3be6d1eb7ff83cb9af9533. This map is based on source inspection; runtime claims are recorded with verification results.

| Requirement | Owner at baseline | Disposition and observable check |
|---|---|---|
| Self-adoption, existing global capabilities and ownership | geppetto-adopt/SKILL.md:10; scripts/install.mjs:144 | Install local skills/scripts, router, config and deterministic hooks; reuse global classifier/scheduler integrations. Verify fresh-session discovery, installed hashes and gate fixtures. |
| Recursive selected branches and terminal page suggestions | scripts/memory-classifier.mjs:28 and :86 | Follow index links only after selection, including several siblings; terminal output contains pages rather than index files. Fixture includes selected grandchildren and an unselected index that must remain unread. |
| Bounded parallel provider calls and request splitting | scripts/memory-provider.mjs:2 | Share a configured concurrency limit across all depths; split bucket and index candidates by the exact serialized request size. A single oversized candidate is an explicit error, with no silent truncation. |
| Same-bucket boundary, privacy, cycles and duplicate targets | scripts/memory-index.mjs:26 | Resolve each target canonically inside its allowed bucket; reject escapes, detect cycles and deduplicate canonical IDs. Verify symlink escape, parent links, shared descendants and deterministic output. |
| Whole-run deadline and interrupted work | scripts/memory-classifier.mjs:52 | Preserve the existing deadline and signal across all queued/running requests; timeout stops scheduling new calls and produces a logged error. |
| Shared cost reservation and unknown provider charges | scripts/memory-classifier.mjs:76 | Reserve once for the whole traversal, aggregate known costs, retain the reservation when any issued call has an unknown cost; exercise concurrent completion and failure. |
| Session injection and persisted configuration | scripts/memory-hook.mjs:10; memory-config.mjs:5 | Preserve startup listing and manually navigable indexes, project/user precedence and existing disabled behaviour; document additional optional controls. |
| User-visible diagnosis | scripts/hook-events.mjs; hooks/README.md | Retain modelCalls, duration, injected bytes, actual/unknown cost and error evidence; document request-size and recursion semantics. |

## Technical implications

Use the current indexes and provider adapter; no extra model service, retry layer or directory-wide content scan. Treat links ending in index.md (or directory links resolving to index.md) as expandable entries. Resolve relative links against the containing index. Validate canonical identities before passing candidates to providers. Keep the existing output form and sort canonical leaf IDs.

Request size is measured in bytes of the actual provider JSON, including schema and prompt; it is not presented as an exact token count. maxRequestBytes is an optional owner-selected cap, chosen for the model during the requested benchmark; absent configuration preserves the existing unsplit behaviour. maxConcurrentRequests is optional and defaults to one for existing configurations; configure more than one to run selected sibling branches/batches concurrently. Both controls are independently tested with explicit synthetic budgets.

## Decisions and discovery gaps

Existing global monthly memory maintenance is reused. Existing requirements and skill suggestion hooks are inspected before installation; requested comparisons of all three classifiers are prepared using synthetic fixtures and existing integrations. Paid runs and permanent enablement remain separate decisions. No classifier performance improvement is claimed from mocked providers.

The baseline memory audit reported a false URL mismatch for the same repository with and without a .git suffix. A narrow correction and regression test cover that adoption blocker. A fresh Codex session has successfully read the router and installed specification skill using the permitted execution mode; initial read-only shell execution was blocked by host policy. Hook trust in an external harness and provider-account spend limits require their respective live evidence.

## Observability

Verification records distinguish source inspection, isolated hook execution, real fresh-session discovery, synthetic provider behaviour and paid-provider benchmark results. No private memory text, credentials or local personal scheduler details belong in public artifacts.


## Steering: receive work feedback

The maintainer requested removal of the engineering-workflow handoff and renaming the bundled review-disposition procedure to receive-work-feedback. Rename its entrypoint and UI metadata, update adoption/verification/code-review callers, package inventory and README, retain MIT licensing and record the original name in provenance. Remove the now-unused optional integration row. Verify package links and installation reconciliation; unrelated global or upstream skill copies stay owned by their existing installations.
