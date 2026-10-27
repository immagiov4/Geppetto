---
name: geppetto-adopt
description: "Install, update, inspect or remove Geppetto in a project."
---

# Install Geppetto

1. **Look.** Run `node <adopt>/scripts/audit.mjs --project <project> --json`. Read project instructions and the machine registry. Inspect plugins, scheduler jobs, key and memory before adding equivalents. Complete when reusable resources and prerequisites are known.
2. **Choose.** An installation request is the yes, including a request containing the repository link. Reuse configured machine memory. Otherwise include the four [memory choices](references/installation.md#memory) in the single install question, alongside hooks, learning and maintenance jobs. Only when OpenRouter is missing, offer its key once through private secret entry. Complete when installation, memory and any key choice are known.
3. **Install.** Follow [installation](references/installation.md), including plugin reuse, native scheduler attachment and local branch/commit. The install request covers creating `geppetto-install` and committing Geppetto's own files there; nothing is pushed. After plugin bootstrap, read this entry directly from its installed path and continue in the same session. Complete when gates and hook checks pass, jobs are attached or the actual blocker is named, and the local commit exists.
4. **Recap.** Give actual results and the instruction diff inline or linked outside the project:

| Installed | Reused from this machine | Skipped and why | How to change |
|---|---|---|---|
| Verified resources | Existing hooks, jobs, key and memory | Missing prerequisites | Configuration or scheduler location |

Include the memory choice, location and control; identify jobs already scheduled on another machine. Complete when the user can inspect the result and find its controls. Rerun to reconcile updates; use `--uninstall` to remove owned files.
