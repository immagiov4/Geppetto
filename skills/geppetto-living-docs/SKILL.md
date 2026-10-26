---
name: geppetto-living-docs
description: "Document while working, one owner per fact. Use when behaviour changes, documentation is stale or duplicated, or a decision may deserve an ADR."
---

# Living docs

Update the owning document in the same change as the behaviour it describes. Look for an existing home before creating Markdown. One fact has one authoritative owner; other pages point there with enough context for the reader. Refactor documentation as code: reconcile contradictions, consolidate duplication and repair the reading path while preserving distinct cases and useful rationale.

Use the documentation root and style recorded during adopt. If the maintainer has no preference, adopt can offer a reference repository whose structure, tone and update conventions can be adapted. Once agreed, encode checkable update conventions in the project's existing tooling; semantic accuracy still needs a reader.

Small and medium design decisions belong in commit bodies when commits are authorized. Retrieve implementation history with log → blame → show. Use `$geppetto-memory` for useful informal rationale that has no existing documentation owner, linking it to the relevant decision or implementation. Reserve ADRs for consequential, durable decisions whose alternatives and effects justify a separate document. Current documentation describes the current contract; memory keeps informal context discoverable and Git preserves how it changed.

Read `$geppetto-x-ray` when a feature's observable behaviour changes, and `$geppetto-behaviour-tests` for significant verification choices. Complete when changed facts have an updated owner, pointers resolve, adopted style is respected and the current page and Git rationale can answer different reader questions. An optional link checker proves reachability, not semantic freshness.
