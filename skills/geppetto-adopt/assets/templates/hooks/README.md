# Project hooks

These hooks do three jobs. At session start they list memory. On each prompt they may suggest pages. During the turn they can remind the agent to record a lesson. Merge the harness files, below, before any of that runs in a project.

## Session memory

`SessionStart` runs `memory-hook.mjs`. It exposes the configured memory location, a one-line description of every root-index bucket, and the full indexes of the linked buckets that are not private. Project `.geppetto/config.json` overrides `~/.geppetto/config.json`. Choose linked buckets with `memory.buckets: ["nous", "geppetto"]`. Legacy `projectBucket` is accepted as a one-element list. Pages and the private bucket's index stay outside hook context. A missing clone produces one reasoned unavailable line. Each injection records its UTF-8 byte count in `.geppetto/hook-events.jsonl`.

## Optional classifier

The same memory hook runs on `UserPromptSubmit`. `hooks.memoryClassifier` defaults to `{ "enabled": true, "benchmark": null }` and operates when its key, selected settings and standing user/project `memory-classifier` grant exist. Obtain the OpenRouter key through the harness secret store and expose it as `OPENROUTER_API_KEY` in the hook environment. Credentials stay outside configuration. Project classifier settings override user settings. Record and show the semantic-hook comparison. Its absence does not block an authorized classifier.

An enabled classifier requires these owner-selected settings:

- `model`
- `bucketThreshold` and `pageThreshold`, inclusive scores in `[0, 1]`
- `timeoutMs`, the deadline for the entire traversal
- `maxOutputTokens`, per request

Optional `maxCostUsd` reserves an owner-selected maximum for the entire traversal. If it is absent, there is no spending cap, and the standing grant must be explicitly unlimited (`budget_usd=none`). Choose the deadline below the enclosing hook's `timeout` in seconds, and leave room for ledger operations and local reads. Increase that enclosing timeout when the traversal needs it. This package supplies no calibrated model or score threshold. Measure selection quality, injected bytes, elapsed time and cost, and retain the benchmark reference. [OpenRouter's API](https://openrouter.ai/docs/api_reference/overview) and [structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs) define the adapter contract.

The first stage receives the current question and the descriptions of global buckets plus linked project buckets, excluding `private`. Each selected bucket's index is then classified on its own. A selected `index.md` or directory link expands to its child index. A selected ordinary Markdown link becomes a page suggestion. Relative links resolve against the containing index. Only selected indexes are read. Page bodies stay local. Canonical paths keep every document inside the selected bucket. An index already visited is not walked again, so a cycle stops. Shared page targets are deduplicated and sorted.

Optional `maxConcurrentRequests` is a positive integer that bounds every provider call across branches and batches. It defaults to 1, so an existing configuration stays serial. Set a larger value to explore in parallel. Optional `maxRequestBytes` is a positive byte limit on the exact serialized provider request, including the question and the output schema. Candidate lists are split into requests within that limit. A single candidate that cannot fit produces a logged error and is not truncated. Without this setting, requests stay unsplit. Choose the byte limit for the selected model during evaluation. Bytes are not an exact token count. The shared deadline, the authorization reservation and the aggregate cost cover every request. An in-flight call whose charge is unknown keeps its reservation.

## Merge into the harness

Merge `claude/settings.json` into `.claude/settings.json` and `codex/.codex/hooks.json` into `.codex/hooks.json`, and keep the hook entries that are already there. Each command finds `.geppetto/bin/hook.mjs` from the working directory's ancestors and launches it with the current Node executable and hidden subprocess windows. Run each exact command from a nested project directory, then review and trust the resulting configuration in the harness. After the owner-approved migration, record the complete merged files with `install.mjs --record-generated`.

## Signal learning

The additional async `PostToolUse`, `Stop` and `SessionStart` entries consume recorded project signals through `learn-host.mjs`. `hooks.signalLearning` defaults to enabled, with Codex `gpt-6.1-sol` on the subscription/default tier, workspace-write file tools, and no run or USD cap. Adoption records accepted standing consent once. A missing CLI or authentication is one actionable audit item. `writeApproval: false` commits retained changes on an isolated local branch. `true` leaves them staged for review. [Event-driven learning](../../../../geppetto-learn/references/ingestion.md) owns acknowledgement, scope, optional limits, accounting, recovery and the canonical Hermes plugin template.

## Learning reminders

For per-message routing, reuse the requirements companion's [existing prompt hook](../../../../requirements-blast-radius/references/screen.md#install-and-check). It supplies one question about changed requirements and one about feedback on the agent's work. Global and project precedence are handled by that hook. Adoption checks for this equivalent before adding another prompt handler.

`UserPromptSubmit` delimits turns. `PreToolUse` records tool starts and still preserves PR feedback and authorization checks. After a tool completes, the synchronous `PostToolUse` handler adds an internal learning reminder through `hookSpecificOutput.additionalContext`, which [Claude Code](https://code.claude.com/docs/en/hooks#posttooluse) and [Codex](https://learn.chatgpt.com/docs/hooks#posttooluse) both support. The active agent judges useful lessons before its final reply and records a signal when one is warranted. The reminder stays in the current conversation. It does not create a user request or a separate session that reads transcripts. `Stop` remains available for the independent asynchronous signal consumer.

Defaults in `.geppetto/config.json` are `hooks.learnNudge: { "enabled": true, "benchmark": null, "minToolCalls": 20, "minDurationMs": 300000 }`. Either threshold qualifies, and the check runs when a tool finishes: twenty tool starts, or five minutes since the first start. These noise filters are initial design choices, not a calibrated quality claim. A turn that qualifies stays eligible for the rest of the session. An atomic per-turn marker suppresses a second reminder from a later or parallel completion in that same turn. Native turn IDs identify the turn. If none is present, the prompt-event identity or the first recorded call is the fallback. A legacy session-wide `fired` marker does not limit reminders. Set `enabled` to false to decline reminders without declining signal learning or the semantic hooks.

The reminder arrives during the work, rather than forcing a check after the final reply. A turn with no tool calls has no delivery point, and neither does a run of failed calls that never reaches a successful tool completion. Hermes uses the same thresholds through its tool-result bridge. When a result cannot carry the reminder, Hermes can defer it to the next internal context callback. Learning children, whether Hermes or CLI, skip reminders.

## Observability

Each firing appends the triggering `PostToolUse` event, session hash, turn identity, timestamp, call count, elapsed milliseconds and handler cost to `.geppetto/hook-events.jsonl`. Activity and per-turn markers stay in ignored `.geppetto/hook-state/`. The handler makes zero model calls and needs no key. The agent's reflection uses the session's ordinary resources. Compare firings with `.geppetto/signals.jsonl` for useful lessons, and include the reflection's actual usage when measuring total cost. If the telemetry append fails, that turn's marker is released so the reminder can be retried. Handler and shipped-command tests cover delivery, repeated turns, parallel deduplication, old markers, privacy exclusions and feedback preservation. Whether the harness loads and displays the reminder still requires a fresh-session check.
