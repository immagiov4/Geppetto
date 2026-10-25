---
name: geppetto-build
description: "Build product behaviour test-first at its existing owner. Use to implement a specified unit, fix a reproducible defect or promote a prototype to product."
---

# Build

**Local fix.** For a qualified [local fix](../geppetto-spec/references/local-fix.md), follow its red → owner correction → green path, focused checks and PR/ticket Observability record, then hand off to `$geppetto-verify`. Load principle skills only for an unresolved concern. Otherwise follow the full path below.

1. **Contract and red proof.** Fix the unit's approved contract and current source identity. Read `$geppetto-behaviour-tests`; write a behaviour test before product code and run it to establish failure for the intended reason. Reuse installed `tdd` when appropriate. An exploratory prototype may omit this step, with that status declared; promotion to product requires tests and refactoring. Complete when the observed failure proves the missing behaviour or the explicit prototype exemption is recorded.
2. **Implement at the owner.** Inspect callers and related implementations, then make the smallest complete change where the behaviour already belongs. Read `$geppetto-reuse-it` before adding a path or tool, `$geppetto-measure-it` before an optimisation claim or new check, and `$geppetto-living-docs` when a documented fact changes. Search siblings for the same supported defect class. Complete when the unit's tests pass and each relevant sibling has a checked disposition.
3. **Prepare the handoff.** Record the available evidence and limits in the PR/ticket `## Observability`. Update the existing feature document only when a documented fact or observability surface changes, using `$geppetto-x-ray`; otherwise the PR/ticket section is the record. Collect the diff, contract, rules and revision for `$geppetto-verify`, keeping implementation reasoning separate from independent review inputs. Complete when an identifiable artifact and its acceptance evidence are ready for verification.

Read [process execution](../geppetto-adopt/references/processes.md) before launching tools. Work within the current authorization; approved implementation does not imply publication or spending permission.
