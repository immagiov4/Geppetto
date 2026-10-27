# Hook operation

The plugin supplies global hooks. The installer reuses them with `--plugin-hooks`, or merges one shared hook set into user settings. `~/.geppetto/machine.json` records the source. SessionStart injects memory listings; UserPromptSubmit adds requirements/feedback routing and OpenRouter suggestions; PreToolUse checks PR text; PostToolUse and Stop supply internal learning reminders; async Stop runs background signal learning.

## Suggestions

`memory-classifier.mjs` coordinates both selectors, validates returned candidate IDs and scores, and logs duration, model calls, injected bytes, errors and API cost. `memory-provider.mjs` and `skill-provider.mjs` implement the OpenRouter transports. The key enables requests; `authz.mjs` accounts for paid calls and an optional machine spend cap.

Memory traversal classifies global and linked project bucket descriptions, then follows selected indexes recursively. Candidate path validation and cycle detection live in `memory-index.mjs` and `memory-traversal.mjs`. Private buckets are excluded. Skill selection independently reads discovered names and descriptions from `skill-catalog.mjs` and points to selected local procedures.

Settings come from `common.mjs`, then user and project overrides. Optional `maxRequestBytes` splits candidate batches against the serialized request size. Optional `maxConcurrentRequests` controls concurrent provider calls; the default is serial. The configured deadline covers the whole traversal and aborts outstanding requests. `maxCostUsd` supplies a per-traversal maximum for paid accounting. Keep the deadline inside the enclosing hook timeout.

## Learning

`learn-nudge.mjs` records tool activity and adds one internal reminder per qualifying turn, using the configured tool-count or elapsed-time threshold. The current agent applies `$geppetto-learn` before replying. The handler uses zero model calls; reflection uses the ordinary session. Events record firings and duplicate suppression state stays under ignored `.geppetto/hook-state/`.

The [background runner](../../../../geppetto-learn/references/ingestion.md) consumes selected signals through the subscription CLI and one machine lock. [Maintenance jobs](../../../../geppetto-learn/references/jobs.md) reuse the existing scheduler.

Hermes uses its [plugin template](hermes/plugin.yaml) for read-only memory listings and learning reminders. Copy `settings.example.json` to the profile's `settings.json` and resolve its paths.
