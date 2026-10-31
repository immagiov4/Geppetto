---
name: geppetto-living-docs
description: "Document while working, one owner per fact. Use when behaviour changes, documentation is stale or duplicated, or a decision may deserve an ADR."
---

# Living docs

If `~/.geppetto/integrations.md` has a section for this skill, read it.

Update the owning document with the behaviour it describes. Reuse an existing home; each fact has one authoritative owner and other pages point there. Reconcile contradictions and duplicates while preserving valid cases and rationale.

Follow `foundations.documentation` in `.geppetto/config.json`, the agreed root/style and the author's structure. Settle audience, page types, recurring sections, navigation, diagrams and update ownership through `$geppetto-spec` before creating a structure. When unset, propose concrete page examples; record and reuse the chosen method. A writing companion refines wording inside that structure. Tables and lists explain choices or procedures; diagrams explain relationships, states and execution paths. Keep documents ordered in the agreed layout. State the existing per-file size limit; if absent, agree one with the author (about 8 KB is an option). Split by topic before exceeding it; keep coherent documents rather than micro-files.

Authorized commit bodies hold ordinary design decisions; log → blame → show retrieves implementation history. Use `$geppetto-memory` for informal rationale without another owner, linked to the decision. Reserve ADRs for consequential durable choices needing alternatives and effects. Current documentation describes the current contract; Git retains its history.

Read `$geppetto-x-ray` for changed observability and `$geppetto-behaviour-tests` for significant verification. Complete when changed facts have owners, pointers resolve and the agreed layout and size limit hold. A link checker establishes reachability; a reader verifies meaning.
