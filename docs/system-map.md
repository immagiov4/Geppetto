# System map

Source procedures live in `skills/`; root manifests expose the plugin. `install.mjs` reuses plugin skills or generates copies for targets without a plugin, supplies CI gates in `.geppetto/bin` and protects ownership. `machine.mjs` reconciles shared resources. [Development](development.md) owns refresh and verification commands.

| Concern | Source owner under `skills/geppetto-adopt/scripts/` |
|---|---|
| Project installation and ownership | `install.mjs` |
| Shared hooks, job identities, key location and memory | `machine.mjs` |
| OS maintenance attachment and subscription CLI execution | `maintenance.mjs` |
| PR feedback and requirements/feedback context | `hook.mjs` |
| In-session learning reminder | `learn-nudge.mjs` |
| Background subscription run and machine lock | `learn-runner.mjs` |
| Current project capture through an isolated Git index | `learning-context.mjs` |
| Bounded learner file tools | `learner-tools.mjs` |
| Memory listing and configuration | `memory-hook.mjs`, `memory-config.mjs` |
| Memory installation and Claude native directory ownership | `memory-setup.mjs` |
| Cross-machine maintenance registrations | `memory-jobs.mjs` |
| Suggestion coordination and telemetry | `memory-classifier.mjs`, `hook-events.mjs` |
| Memory indexes and traversal | `memory-index.mjs`, `memory-traversal.mjs` |
| OpenRouter adapters | `memory-provider.mjs`, `skill-provider.mjs` |
| Skill catalog and prompt hook | `skill-catalog.mjs`, `skill-hook.mjs` |
| Paid API accounting | `authz.mjs` |
| Codex native hook trust | `codex-hook-trust.mjs` |
| Structural gates and instruction migration | `gate-agents.mjs`, `gate-sections.mjs`, `migrate-agents.mjs` |

Tests exercise public script and hook flows with temporary repositories and injected providers. `scripts/check-skills.mjs` checks the distributable inventory and document links. [Memory retrieval](memory-retrieval.md) describes recursive indexing; [learning](../skills/geppetto-learn/references/ingestion.md) owns the background lifecycle.
