# Development

Edit the distributable files in `skills/`, including the scripts in `skills/geppetto-adopt/scripts/`. Local installed skills and `.geppetto/bin/` are generated copies. After a source change, refresh them with the source installer. Review a dry-run first:

```sh
node skills/geppetto-adopt/scripts/install.mjs --target <claude|codex|agents> --project . --dry-run
node skills/geppetto-adopt/scripts/install.mjs --target <claude|codex|agents> --project .
```

The install contract, targets and exit codes are in [installation](../skills/geppetto-adopt/references/installation.md). Keep third-party provenance in `THIRD_PARTY_NOTICES.md`.

Run `npm run check` for package integrity, router validation and behaviour tests. CI runs the same command on Windows and Linux, with Node 22 and Node 24. The Node scripts have no package dependencies, so this check does not install any.

Keep tests synthetic, and independent of personal memory, credentials and paid providers. Provider adapters accept an injected transport, so a check can be deterministic. A paid classifier comparison is a different proof, described in [classifier evaluation](classifier-evaluation.md). It needs a recorded data-and-spending consent. Record the measurement. Do not use the results as an activation gate.

Change a behaviour in the source file that already owns it. The owner table is the [system map](system-map.md). State what the change does not cover. Keep user-facing documentation in English. A public issue or pull request includes a meaningful Observability section. Before opening the PR, run `node .geppetto/bin/gate-sections.mjs --pr <body-file>`. CI runs the same gate on the PR body. That check is separate from `npm run check`.
