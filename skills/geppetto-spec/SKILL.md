---
name: geppetto-spec
description: "Specify a change before code: human flow, design limits, requirements map and small units. Use for a feature plan, a grill session or steering that changes the agreed outcome."
---

# Specify

If `~/.geppetto/integrations.md` has a section for this skill, read it.

**Foundations.** Resolve `.geppetto/config.json` `foundations` or supplied project values. For documentation or diagnostics, record an existing convention when present. Otherwise, with its foundation unset, propose 2–3 concrete options with tradeoffs and decide WITH the user before writing. Record the choice in `foundations.documentation` or `foundations.observability`. Follow recorded choices without asking again.

**Local fix.** For one located owner, no contract/UI change and no dependency, use the [local-fix route](references/local-fix.md): record owner, invariant and focused proof, then hand off to `$geppetto-build`. Load principle skills for unresolved concerns. Otherwise follow the full path.

1. **Human flow.** State states, outcomes, observable acceptance criteria and invariants against the requested outcome. Complete when the user can recognize each result.
2. **Design.** Examine system, API and implementation through UX, performance and quality. State limits, evidence, alternatives and falsifiable assumptions. Read `$geppetto-reuse-it` before machinery and `$geppetto-measure-it` before performance claims or checks. Complete when choices and disconfirming evidence are traceable.
3. **Requirements map.** Invoke `$requirements-blast-radius`, reusing a supplied map and investigating uncovered changes. Follow delivery paths and lifecycle boundaries to owners; zoom and lenses belong here. Complete when requirements map to owners and proof, with discovery gaps explicit.
4. **Recalibrate.** Write the final specification against the map. Give small units dependencies and observable proof. Preserve invariants in existing or requested tests. Complete when every invariant has a test owner and units are independently verifiable.
5. **Control growth.** Compare evidence with the unit's contract. Route collateral work through authorized tickets; ask for changed product scope. Reconsider a nonconverging approach instead of setting a round limit. Complete when the unit remains bounded or an explicit decision owns its expansion.

Use installed `grilling`, `to-spec` or `to-tickets` where applicable. Read `$geppetto-x-ray` for visibility, `$geppetto-living-docs` for documentation and [process execution](../geppetto-adopt/references/processes.md) before tools.
