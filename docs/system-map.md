# System map

Source procedures live in `skills/`; root manifests expose the plugin. `install.mjs` reuses plugin skills or generates copies for targets without a plugin, pins package CI gates in the project workflow and protects ownership. `machine.mjs` reconciles shared resources. [Development](development.md) owns refresh and verification commands.

| Concern | Source owner under `skills/geppetto-adopt/scripts/` |
|---|---|
| Project installation and ownership | `install.mjs` |
| Shared hooks, job identities and memory | `machine.mjs` |
| OS maintenance attachment and subscription CLI execution | `maintenance.mjs` |
| PR feedback, requirements/feedback context and diff-bound review gate | `hook.mjs` |
| Learning activity, background launch and transcript reduction | `learn-nudge.mjs` |
| Background subscription run and machine lock | `learn-runner.mjs` |
| Current project capture through an isolated Git index | `learning-context.mjs` |
| Structured learning decisions and validation | `learning-result.mjs` |
| Bounded learner file tools | `learner-tools.mjs` |
| Memory listing and configuration | `memory-hook.mjs`, `memory-config.mjs` |
| Memory installation and Claude native directory ownership | `memory-setup.mjs` |
| Cross-machine maintenance registrations | `memory-jobs.mjs` |
| Hook telemetry | `hook-events.mjs` |
| Memory indexes | `memory-index.mjs` |
| Codex native hook trust | `codex-hook-trust.mjs` |
| Structural gates and instruction migration | `gate-agents.mjs`, `gate-sections.mjs`, `migrate-agents.mjs` |

Tests exercise public script and hook flows with temporary repositories and injected providers. `scripts/check-skills.mjs` checks the distributable inventory and document links. [Memory retrieval](memory-retrieval.md) describes recursive indexing; [learning](../skills/geppetto-learn/references/ingestion.md) owns the background lifecycle.

## Observability

The mapped scripts expose gate diagnostics, audit readiness and hook-event records at their owning boundaries. The [adoption checks](adoption.md#observability) describe their runtime evidence; this map records source ownership, which remains a source-review responsibility.
