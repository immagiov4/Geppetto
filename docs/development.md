# Development

Edit the distributable files in `skills/`. Local installed skills and `.geppetto/bin/` are generated copies; refresh them with the source installer after source changes. Preserve third-party provenance in `THIRD_PARTY_NOTICES.md`.

Run `npm run check` for package integrity, router validation and behaviour tests. CI runs the same command on Windows and Linux with Node 22 and 24. Node scripts have no package dependencies.

Keep tests synthetic, independent of personal memory, credentials and paid providers. Provider adapters accept injected transports for deterministic checks. Paid classifier work needs recorded data-and-spending consent; comparisons are measured and recorded without gating an otherwise authorized hook.

Use the existing source owners and name domain limits. Keep user-facing documentation in English. Public issue and pull-request bodies include a meaningful Observability section.
