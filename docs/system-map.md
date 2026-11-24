# System map

Source procedures live in `skills/`; root manifests expose the plugin. `install.mjs` reuses plugin skills or generates copies for targets without a plugin, pins package CI gates in the project workflow and protects ownership. `machine.mjs` reconciles shared resources. [Development](development.md) owns refresh and verification commands.

[Specify](../skills/geppetto-spec/SKILL.md) owns the handoff from design to build. On the full path, a fresh session reviews the finished specification and its design inputs for open decisions; when none is available, the author self-reviews and records `spec review pending`. Before handing off to build, each flag is answered in the spec or explicitly decided, and the user decides product scope.

| Concern | Source owner under `skills/geppetto-adopt/scripts/` |
|---|---|
| Project installation and ownership | `install.mjs` |
| Source-sharing setup and requirements screening evidence | `screen-config.mjs` and `requirements-blast-radius/scripts/screen.py` |
| Published versions, startup notices and installation drift | `update-check.mjs` |
| Operation timing, anomalies and metrics audit | `metrics.mjs`, `metric-anomalies.mjs`, `metrics-audit.mjs` |
| Shared hooks, job identities and memory | `machine.mjs` |
| Weekly analysis and experiment proposals | `weekly-report.mjs`, `maintenance.mjs` |
| OS maintenance attachment and subscription CLI execution | `maintenance.mjs` |
| PR feedback, pre-edit decisions and completion review | `hook.mjs`, `turn-checks.mjs` |
| Antigravity hook contract adapter and context delivery | `antigravity.mjs` |
| Learning activity and in-turn reminders | `learn-nudge.mjs` |
| Weekly subscription CLI execution | `learn-runner.mjs` |
| Bounded learner file tools | `learner-tools.mjs` |
| Memory listing and configuration | `memory-hook.mjs`, `memory-config.mjs` |
| Memory installation and Claude native directory ownership | `memory-setup.mjs` |
| Cross-machine maintenance registrations | `memory-jobs.mjs` |
| Shared repository journals, legacy recovery | `project-records.mjs` |
| Hook telemetry | `hook-events.mjs` |
| Evidence keys, categories, merging and proposals | `signal.mjs`, `learning-defaults.json` |
| Read/outcome reports and companion compilation | `audit.mjs`, `maintenance.mjs` |
| Memory indexes | `memory-index.mjs` |
| Codex native hook trust | `codex-hook-trust.mjs` |
| Structural gates and instruction migration | `gate-agents.mjs`, `gate-sections.mjs`, `migrate-agents.mjs` |

Tests exercise public script and hook flows with temporary repositories and injected providers. `scripts/check-skills.mjs` checks the distributable inventory and document links. [Memory retrieval](memory-retrieval.md) describes recursive indexing; [learning](../skills/geppetto-learn/references/ingestion.md) owns the in-turn lifecycle.

## Observability

The mapped scripts expose gate diagnostics, audit readiness and hook-event records at their owning boundaries. The [adoption checks](adoption.md#observability) describe their runtime evidence; this map records source ownership, which remains a source-review responsibility.
