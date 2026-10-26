# System map

Procedures live in `skills/`. Root plugin manifests expose that collection to the harness. The installer generates harness skill copies and the scripts in `.geppetto/bin/`, then records what it owns in a local manifest. Edit the source paths below, not those copies. [Development](development.md) names the refresh command and the checks.

Once that copy is installed, hooks add session behaviour the skill files do not run by themselves. `hook.mjs` supplies requirements/feedback routing on user prompts, handles early feedback and adds internal learning reminders after tool completion in qualifying turns. The prompt text is shared with the standalone requirements hook through `requirements-blast-radius/scripts/message-context.cjs`, copied into `.geppetto/bin` for project installations. Stop events leave reply completion uninterrupted. `memory-hook.mjs` lists session memory and may classify a request. How classification chooses pages is [recursive memory retrieval](memory-retrieval.md). When it is allowed to run is in the [hook reference](../skills/geppetto-adopt/assets/templates/hooks/README.md).

Optional [event-driven learning](../skills/geppetto-learn/references/ingestion.md) is not one of those hooks. `learn-dispatch.mjs` starts an investigation and keeps its native identity, outcome and recovery evidence. The investigation reads through `learning-files.mjs` and stages commits through `learning-worktree.mjs`. `learn-hosts.mjs` adapts the learning host, Codex or Claude. That host receives no shell and no publication tool. `learn-host.mjs` is the event and query entrypoint. Whether the investigation may run is consent recorded by `authz.mjs`, separate from an optional spending cap.

Hermes is a separate install path. Its plugin source is `skills/geppetto-adopt/assets/templates/hooks/hermes/plugin.yaml`. The installer does not modify a running Hermes profile.

Tests in `tests/` call the public script and hook flows with temporary repositories and injected providers.

The per-message skill selector is `skill-hook.mjs`. `skill-catalog.mjs` resolves available names, descriptions and local procedure paths; `skill-provider.mjs` adapts Mercury's decision questions. `memory-classifier.mjs` coordinates both classifiers' authorization, queue, deadline and accounting. Skill selection uses no memory repository or transcript. Its setup and coexistence rules live in [skill suggestions](../skills/geppetto-adopt/assets/templates/hooks/README.md#skill-suggestions).

## Owners

Script sources under `skills/geppetto-adopt/scripts/` install into `.geppetto/bin/`. Edit the source path. The package-root check script is listed with its full path.

| Concern | Owner |
|---|---|
| Project configuration and installation | `skills/geppetto-adopt/` |
| Early feedback and learning reminders | `skills/geppetto-adopt/scripts/hook.mjs` |
| Session memory listing and optional per-request classification | `skills/geppetto-adopt/scripts/memory-hook.mjs` |
| Recursive classification, deadline and cost reservation | `skills/geppetto-adopt/scripts/memory-classifier.mjs` |
| Selected-index expansion | `skills/geppetto-adopt/scripts/memory-traversal.mjs` |
| Project and user choices | `skills/geppetto-adopt/scripts/memory-config.mjs` |
| Index boundaries | `skills/geppetto-adopt/scripts/memory-index.mjs` |
| OpenRouter transport | `skills/geppetto-adopt/scripts/memory-provider.mjs` |
| Hook diagnosis log | `skills/geppetto-adopt/scripts/hook-events.mjs` |
| Authorization, accounting, and consent distinct from an optional spending cap | `skills/geppetto-adopt/scripts/authz.mjs` |
| Learning dispatch | `skills/geppetto-adopt/scripts/learn-dispatch.mjs` |
| Native learning adapters | `skills/geppetto-adopt/scripts/learn-hosts.mjs` |
| Learning event and query entrypoints | `skills/geppetto-adopt/scripts/learn-host.mjs` |
| Resolved learning policy, CLI discovery and subscription readiness | `skills/geppetto-adopt/scripts/learning-config.mjs` |
| Accepted adoption answer and standing project grant | `skills/geppetto-adopt/scripts/learning-setup.mjs` |
| Bounded file tools for an investigation | `skills/geppetto-adopt/scripts/learning-files.mjs` |
| Isolated local staging and commits | `skills/geppetto-adopt/scripts/learning-worktree.mjs` |
| Hermes plugin source | `skills/geppetto-adopt/assets/templates/hooks/hermes/plugin.yaml` |
| Public script and hook flows | `tests/` |
| Distributable skills, templates and documentation links | `scripts/check-skills.mjs` |
| Session working rules | `AGENTS.md` |
| Verification commands and conventions | [development](development.md) |
