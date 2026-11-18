---
name: geppetto-spec
description: "Specify a change before code: human flow, design limits, requirements map and small units. Use for feature plans, grill sessions or steering that changes the agreed outcome."
---

# Specify

If `~/.geppetto/integrations.md` has a section for this skill, read it.

**Foundations.** Resolve `.geppetto/config.json` `foundations` or supplied values. Design inspectability for new or changed behaviour through `$geppetto-x-ray`. If `foundations.observability` is unset for that work, compare approaches WITH the user and record the choice. For documentation, likewise record `foundations.documentation`: audience, page types, structure, navigation and visuals. A prose companion refines that structure. Reuse recorded choices without asking again.

**Local fix.** For one located owner, no contract/UI change and no dependency, use the [local-fix route](references/local-fix.md): record owner, invariant and focused proof, then hand off to `$geppetto-build`. Load principle skills for unresolved concerns. Otherwise follow the full path.

1. **Human flow.** State states, outcomes, observable acceptance criteria and invariants against the requested outcome. Complete when the user can recognize each result.
2. **Design.** Examine system, API and implementation through UX, performance and quality. Strongly recommend `architect` for competing designs and `codebase-design` for module responsibilities and interfaces; offer installation when absent. State limits, evidence, alternatives and falsifiable assumptions. Read `$geppetto-reuse-it` before machinery and `$geppetto-measure-it` before performance claims or checks. Design normal operation, state transitions and diagnostic access through `$geppetto-x-ray` alongside behavior. Complete when choices, observation points and disconfirming evidence are traceable.
3. **Requirements map.** Invoke `$requirements-blast-radius`, reusing a supplied map and investigating uncovered changes. Follow delivery paths and lifecycle boundaries to owners; zoom and lenses belong here. Complete when requirements map to owners and proof, with discovery gaps explicit.
4. **Recalibrate.** Write the final specification against the map, including `## Inspectability` with the technical design from `$geppetto-x-ray` for new or changed behaviour, even when there is no PR or issue. Give small units dependencies and observable proof. Preserve invariants in existing or requested tests. Complete when every invariant has a test owner, changed behaviour is inspectable, and units are independently verifiable.
5. **Control growth.** Compare evidence with the unit's contract. Route collateral work through authorized tickets; ask for changed product scope. Reconsider a nonconverging approach instead of setting a round limit. Complete when the unit remains bounded or an explicit decision owns its expansion.

Use installed `grilling`, `to-spec` or `to-tickets` where applicable. Read `$geppetto-x-ray` for technical observability, `$geppetto-living-docs` for documentation and [process execution](../geppetto-adopt/references/processes.md) before tools.
