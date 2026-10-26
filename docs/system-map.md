# System map

Geppetto distributes agent procedures and deterministic Node scripts. Root plugin manifests expose the source `skills/` collection. The installer copies that collection into the target harness and scripts into `.geppetto/bin/`, recording ownership in a local manifest.

`geppetto-adopt` owns project configuration and installation. `hook.mjs` handles early feedback and learning reminders; `memory-hook.mjs` handles session memory listings and optional per-request classification. `memory-config.mjs` resolves project/user choices, `memory-index.mjs` enforces index boundaries, and `memory-provider.mjs` is the OpenRouter transport. Authorization and accounting are owned by `authz.mjs`. Optional [event-driven learning](../skills/geppetto-learn/references/ingestion.md) uses `learn-dispatch.mjs`, native adapters in `learn-hosts.mjs`, and `learn-host.mjs` event/query entrypoints. Canonical Hermes plugin sources live in the adoption hook templates; the installer does not modify a running Hermes profile.

Tests in `tests/` exercise the public script and hook flows using temporary repositories and injected providers. `scripts/check-skills.mjs` checks distributable skills, templates and documentation links. Project working rules start in `AGENTS.md`; [development](development.md) owns verification commands and conventions.
