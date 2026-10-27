# Hook operation

The plugin supplies global hooks. The installer reuses them with `--plugin-hooks`, or merges one shared hook set into user settings. `~/.geppetto/machine.json` records the source. SessionStart injects memory listings; UserPromptSubmit adds requirements/feedback routing and OpenRouter skill suggestions; PreToolUse checks PR text; PostToolUse and Stop supply internal learning reminders; async Stop runs background signal learning.

## Suggestions

`memory-classifier.mjs` coordinates skill selection, validates returned candidate IDs and scores, and logs duration, model calls, injected bytes, errors and API cost. `skill-provider.mjs` reuses the typed decision transport in `memory-provider.mjs`. The key enables requests; `authz.mjs` accounts for paid calls and an optional machine spend cap.

SessionStart supplies memory listings and linked project indexes for the agent to navigate through `$geppetto-memory`. Skill selection reads discovered names and descriptions from `skill-catalog.mjs` and points to selected local procedures. The memory hook ignores prompt events, including legacy registrations with classifier settings enabled.

Settings come from `common.mjs`, then user and project overrides. Optional `maxRequestBytes` splits candidate batches against the serialized request size. Optional `maxConcurrentRequests` controls concurrent provider calls; the default is serial. The configured deadline covers the whole traversal and aborts outstanding requests. `maxCostUsd` supplies a per-traversal maximum for paid accounting. Keep the deadline inside the enclosing hook timeout.

## Learning

`learn-nudge.mjs` records tool activity and adds one internal reminder per qualifying turn, using the configured tool-count or elapsed-time threshold. The current agent applies `$geppetto-learn` before replying. The handler uses zero model calls; reflection uses the ordinary session. Events record firings and duplicate suppression state stays under ignored `.geppetto/hook-state/`.

The [background runner](../../../../geppetto-learn/references/ingestion.md) consumes selected signals through the subscription CLI and one machine lock. [Maintenance jobs](../../../../geppetto-learn/references/jobs.md) reuse the existing scheduler.

PostToolUse also recognizes Write/Edit/MultiEdit and apply_patch paths in Claude's native memory, configured `autoMemoryDirectory` and Codex's `<CODEX_HOME>/memories/`. With bucket memory configured it reminds once per turn to save durable lessons through `$geppetto-memory`; a native directory inside a bucket instead prompts index upkeep. This uses the existing dispatch, an exclusive turn marker and a zero-model-call `nativeMemory` event in the same hook log. Native-only and no-memory choices keep bucket hooks silent. The end-of-turn nudge includes lessons and decision rationale without another owner.

Hermes uses its [plugin template](hermes/plugin.yaml) for read-only memory listings and learning reminders. Copy `settings.example.json` to the profile's `settings.json` and resolve its paths.
