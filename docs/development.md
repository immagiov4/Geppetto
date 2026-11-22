# Development

Edit the distributable files in `skills/`, including the scripts in `skills/geppetto-adopt/scripts/`. Targets without a plugin receive generated skill copies. After a source change, refresh them with the source installer. Review a dry-run first:

```sh
node skills/geppetto-adopt/scripts/install.mjs --target <claude|codex|agents> --project . --dry-run
node skills/geppetto-adopt/scripts/install.mjs --target <claude|codex|agents> --project . --plugin-hooks
```

The install contract, targets and exit codes are in [installation](../skills/geppetto-adopt/references/installation.md). Keep third-party provenance in `THIRD_PARTY_NOTICES.md`.

Run `npm run check` for package integrity, router validation and behaviour tests. CI runs the same command on Windows and Linux, with Node 22 and Node 24. The Node scripts have no package dependencies, so this check does not install any.

Change a behaviour in the source file that already owns it. The owner table is the [system map](system-map.md). Keep user-facing documentation in English. An issue or pull request for new or changed behaviour includes Inspectability. Reviewers check that it explains how to inspect the behaviour and diagnose relevant failures. Before opening the PR, run `node skills/geppetto-adopt/scripts/gate-sections.mjs --pr <body-file>`. CI runs the same gate on the PR body. That check is separate from `npm run check`.

For installed-version drift, use the [update diagnosis](../skills/geppetto-adopt/references/installation.md#update). Use the [metrics audit](../skills/geppetto-adopt/assets/templates/hooks/README.md#duration-metrics) to inspect runtime evidence for decisions, timing and pull requests.

Tests use synthetic repositories and injected providers. The test setup gives each process a temporary home and removes inherited provider credentials before fixtures load. Paid provider comparisons run separately.

Package checks validate skill metadata, inventory and links. Review explains growth in code and instructions. For a deployment with a specific instruction limit, supply it to the router check: `--max-bytes` counts the UTF-8 bytes of the router plus every file it loads (imports and a sibling `CLAUDE.md`), and `--max-lines` counts the lines of the router file alone. Codex truncates project instructions at its own configurable `project_doc_max_bytes`.
Shell behaviour fixtures also require Git, Python and ripgrep; CI installs ripgrep explicitly and uses the runners' Git and Python.

Every change to shipped files in `skills/`, `.claude-plugin/`, `.codex-plugin/` or `.agents/plugins/` reaching main carries a version bump.
Keep the same version in `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.codex-plugin/plugin.json` and `.agents/plugins/marketplace.json`.
Use a patch for fixes and a minor version for new or removed behaviour; run `node scripts/bump-version.mjs <x.y.z>`.

## Observability

The package check reports inventory and pointer errors by file and line; the behaviour suite reports failed public script and hook flows. These local results cover synthetic fixtures on the running Node version. The CI matrix owns Windows/Linux and Node 22/24 coverage; installed hook activation is verified in its target harness through the linked installation procedure.
