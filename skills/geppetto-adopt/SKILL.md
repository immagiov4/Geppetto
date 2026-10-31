---
name: geppetto-adopt
description: "Install, update, inspect or remove Geppetto in a project."
---

# Install Geppetto

If `~/.geppetto/integrations.md` has a section for this skill, read it.

1. **Look.** Run `node <adopt>/scripts/audit.mjs --project <project> --json`. Read project instructions and the machine registry. Inspect plugins, scheduler jobs and memory before adding equivalents. Complete when reusable resources and prerequisites are known.
2. **Choose.** An installation request is the yes, including a request containing the repository link. Ask the single [install question](references/installation.md#capability-question): the person installing does not know what Geppetto does, so each line explains the capability and where data goes. Present the minimal invariants and configurable workflow defaults alongside the project's existing skills; agree adaptations before installation. Complete when the choices and any workflow conflicts have a recorded resolution.
3. **Install.** Follow [installation](references/installation.md), including plugin reuse, native scheduler attachment and local branch/commit. Adapt the bundled router into the project's `AGENTS.md`, preserving existing rules, and register it with `--record-generated AGENTS.md` before the final audit and commit. Resolve missing generated instructions in this installation rather than handing them back as a prerequisite. The install request covers creating `geppetto-install` and committing Geppetto's own files there; nothing is pushed. After plugin bootstrap, read this entry directly from its installed path and continue in the same session. Complete when gates and hook checks pass, jobs are attached or the actual blocker is named, and the local commit exists.
4. **Recap.** Give actual results and the instruction diff inline or linked outside the project:

| Installed | Reused from this machine | Skipped and why | How to change |
|---|---|---|---|
| Verified resources | Existing hooks, jobs and memory | Missing prerequisites | Configuration or scheduler location |

Repeat each install-question line with its actual value and how to change it, including the memory location; identify jobs already scheduled on another machine. Complete when the user can inspect the result and find its controls. Rerun to reconcile updates; use `--uninstall` to remove owned files.
