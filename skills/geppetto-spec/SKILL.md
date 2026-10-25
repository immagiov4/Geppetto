---
name: geppetto-spec
description: "Specify a change before code: human flow, design limits, requirements map and small units. Use for a feature plan, a grill session or steering that changes the agreed outcome."
---

# Specify

**Local fix.** For a narrow, already-located change with one existing owner, no contract or UI change and no new dependency, use the [local-fix route](references/local-fix.md): record the owner, invariant and focused proof, then hand off to `$geppetto-build`. Load principle skills only for an unresolved concern. Otherwise follow the full path below.

1. **Human flow.** State the UI or operational flow, states, outcomes, observable acceptance criteria and product/technical invariants. Ground each criterion in the maintainer's requested outcome. Complete when a user can tell whether each criterion holds by observing the result.
2. **Design.** Examine system, API and implementation with UX, performance and quality lenses. State non-obvious limits, evidence or a rejected alternative for each choice, and falsifiable assumptions. Read `$geppetto-reuse-it` before proposing machinery, and `$geppetto-measure-it` before a performance claim or a new rule/check. Complete when choices are traceable and assumptions have a disconfirming check.
3. **Requirements map.** Invoke `$requirements-blast-radius`; reuse an existing orchestrator map and investigate only uncovered changes. Follow all delivery paths and lifecycle boundaries to their owners. Zoom and lenses belong to that discovery, not a separate zoom skill. Complete when each surface and applicable boundary maps requirement → owner → proof, with discovery gaps explicit.
4. **Recalibrate.** Revise the design against the map and write the final specification containing only the change to implement. Give each small unit dependencies and observable proof. Preserved invariants belong in existing or requested tests; an incomplete suite does not establish their preservation. Complete when every discovered invariant has a test owner and each unit can be verified on its own.
5. **Control growth.** Compare new evidence with the unit's contract. Separate collateral work into a ticket under the project's issue authorization; ask for a product decision when scope changes. Reconsider the approach when review fails to converge rather than setting an arbitrary round limit. Complete when the unit remains bounded or an explicit revised decision owns the larger work.

Use installed `grilling`, `to-spec` or `to-tickets` for their applicable branches; the procedure remains usable without them. Read `$geppetto-x-ray` while designing visibility and `$geppetto-living-docs` when updating the owning specification. Read [process execution](../geppetto-adopt/references/processes.md) before launching tools.
