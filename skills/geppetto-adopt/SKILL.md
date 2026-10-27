---
name: geppetto-adopt
description: "Install, update, inspect or remove Geppetto in a project."
---

# Install Geppetto

1. **Look.** Run `node <adopt>/scripts/audit.mjs --project <project> --json`. Read the project's instructions and `~/.geppetto/machine.json`. Reuse the machine's hooks, jobs, key location and memory repository. Inspect existing plugin hooks and scheduler jobs before adding equivalents. Complete when existing resources and missing prerequisites are identified.
2. **Ask once.** “Install Geppetto here, with its hooks, automatic learning and maintenance jobs?” Reuse an answer already given to this installation question. If OpenRouter is missing, make one short optional offer: “Add an OpenRouter key? It improves skill and memory suggestions.” Use the host's private secret entry. Complete when the installation answer and optional key choice are known.
3. **Install.** Follow [installation](references/installation.md). Run the installer for each target, passing `--plugin-hooks` when the installed plugin supplies hooks. Adapt the router and CI to existing project conventions; apply instruction migration on the local installation branch. Attach missing maintenance jobs through the available scheduler and record their identifiers in the machine registry. Preserve existing settings. Run the gates and a hook smoke test. Complete when installed resources pass their checks and any unavailable prerequisite has a concrete reason.
4. **Recap.** Give this short table with actual results and a link to the applied instruction diff:

| Installed | Reused from this machine | Skipped and why | How to change |
|---|---|---|---|
| Verified resources | Existing hooks, jobs, key and memory | Missing prerequisites | Configuration or scheduler location |

Complete when the user can inspect the result and find its controls. Rerun to reconcile updates; use `--uninstall` to remove owned files.
