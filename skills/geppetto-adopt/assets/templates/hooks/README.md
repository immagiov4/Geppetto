# Hook operation

The plugin supplies global hooks. The installer reuses them with `--plugin-hooks`, or merges one shared hook set into user settings. `~/.geppetto/machine.json` records the source. SessionStart injects memory listings; UserPromptSubmit adds requirements/feedback routing and OpenRouter skill suggestions; PreToolUse checks PR text; PostToolUse and Stop supply internal learning reminders; async Stop runs background signal learning.

## Activation

After installing, changing or curating a hook, synchronize every authorized copy and complete activation of the final definition in each affected harness and project. Finish package refreshes, including a Git-backed plugin cache's revision update, before approving its hashes; a later refresh can invalidate the approval even when hook commands stay the same. An authorized hook change, including a metric-justified improvement already authorized by the user, includes its activation; do not ask for consent again for that completion. A change to permissions or effects beyond the approved change is a separate decision.

- **Codex:** inspect the current definitions with `node <adopt>/scripts/codex-hook-trust.mjs --project <project> --plugin <actual-plugin-id>` (or `--source <hooks-file>` or repeated `--key <key>`). After reviewing the authorized scope, run the same command with `--approve`. The helper approves enabled, non-managed hooks in that scope using current hashes and rereads them; inspect its output for disabled hooks, warnings and trust status. A changed payload, command or configuration can invalidate trust. Verify the final hashes and an actual hook event in the same Codex harness and project that will run it; a separate app-server inventory alone is not proof of execution.
- **Claude Code:** settings edits are normally picked up by its file watcher. Confirm the intended hook is enabled and observed in the target session; reload the plugin or start a fresh session if that session has not loaded the final definition. Use the native `/hooks` view and debug output when needed.
- **Hermes:** enable the installed plugin with `hermes plugins enable <name>` in the intended profile, then ensure the serving process has loaded the final version (restart or reload it where required). Verify the hook's effect in that same profile and serving process. A plugin on disk or an enabled flag alone is not proof that its hook is running.

If activation cannot be completed, report the exact blocker and leave the hook's active state unclaimed. Keep changes within the authorized installation and project scope.

## Result attribution

Result records in the project's ignored `.geppetto/hook-events.jsonl` include `sessionId` and `turnId` when the triggering harness supplies them. Match these identifiers to the session being investigated before attributing a result: probes and other sessions can write to the same project log. Historical records and events from harnesses without identifiers remain unattributed. The log records selected Geppetto outcomes; native `hook/started` and `hook/completed` events identify failures before a script starts, including Codex plugin-content approval failures.

## Suggestions

`skill-selector.mjs` coordinates skill selection, validates returned candidate IDs and scores, and logs duration, model calls, injected bytes, errors and API cost. `skill-provider.mjs` owns the typed decision transport. The key enables requests; `authz.mjs` accounts for paid calls and an optional machine spend cap.

SessionStart supplies memory listings and linked project indexes for the agent to navigate through `$geppetto-memory`. Skill selection reads discovered names and descriptions from `skill-catalog.mjs` and points to selected local procedures. The memory hook ignores prompt events.

Settings come from `common.mjs`, then user and project overrides. Optional `maxRequestBytes` splits candidate batches against the serialized request size. Optional `maxConcurrentRequests` controls concurrent provider calls; the default is serial. The configured deadline covers the whole selection and aborts outstanding requests. `maxCostUsd` supplies a per-selection maximum for paid accounting. Keep the deadline inside the enclosing hook timeout.

## Learning

`learn-nudge.mjs` records tool activity and adds one internal reminder per qualifying turn, using the configured tool-count or elapsed-time threshold. The current agent applies `$geppetto-learn` before replying. The handler uses zero model calls; reflection uses the ordinary session. Events record firings and duplicate suppression state stays under ignored `.geppetto/hook-state/`.

The [background runner](../../../../geppetto-learn/references/ingestion.md) consumes selected signals through the subscription CLI and one machine lock. [Maintenance jobs](../../../../geppetto-learn/references/jobs.md) reuse the existing scheduler.

PostToolUse also recognizes Write/Edit/MultiEdit and apply_patch paths in Claude's native memory, configured `autoMemoryDirectory` and Codex's `<CODEX_HOME>/memories/`. With bucket memory configured it reminds once per turn to save durable lessons through `$geppetto-memory`; a native directory inside a bucket instead prompts index upkeep. This uses the existing dispatch, an exclusive turn marker and a zero-model-call `nativeMemory` event in the same hook log. Native-only and no-memory choices keep bucket hooks silent. The end-of-turn nudge includes lessons and decision rationale without another owner.

Hermes uses its [plugin template](hermes/plugin.yaml) for read-only memory listings and learning reminders. Copy `settings.example.json` to the profile's `settings.json` and resolve its paths.
