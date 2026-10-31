---
name: write-pr
description: "Draft or revise a pull-request body from the actual change and verification evidence. Use when no maintainer-selected PR procedure already owns the task."
---

# Write a reviewable PR

## Resolve the contract

Read project instructions, its PR template, body validators, originating requirement, diff and current-revision verification. A maintainer-selected PR procedure takes precedence over this fallback. Preserve the project's required sections, format, evidence rules and publication authorization; use the defaults below only where that contract is silent. Language refinement belongs to Writing for Humans or the maintainer's selected simplifier, such as unslop; this procedure owns format and evidence.

## Draft from the result

Lead with the concrete problem and resulting behaviour, then explain what changed and why. By default, use separate **Problem:**, **Approach:** and **Result:** paragraphs, at most 200 visible words, with supporting notes in a collapsed Details block. Retain issue references and distinguish completed work from partial progress.

Describe the actual Result in a sentence for a trivial change whose Approach already makes the outcome clear. Add a comparison when it helps the reviewer; prefer `Before | → After` for table headers. Reserve numeric comparisons for measurements. Say **Not measured** when a missing measurement limits a claim, rather than adding it as boilerplate.

Show the work where it supports the claim:

- Visible changes: inspected screenshots or a short video of the affected states and interaction. Place images or video under Result, after any comparison table and before Observability.
- Structural changes: the smallest useful diagram, call tree, file tree or diff sketch revealing the changed ownership, ordering or boundary. A small direct edit can be clear from its linked diff.
- Behaviour changes: the actual failing/passing run or reproduction output, including scenario, observed result and tested revision. Distinguish execution evidence from pseudocode or an expected result.

Use durable reviewer-accessible attachments, commit permalinks, check runs or approved artifact storage. Check that each link resolves to the claimed evidence with the intended access and retention; expiring artifacts need a retained summary or durable copy. Local paths are working references, not published proof. Use synthetic evidence where real inputs are private. Mark missing proof as pending and narrow the claim. Choose useful evidence, without decorative visuals.

## Keep the review surface short

Where the project has no different convention, use `## 👁️ Observability` for how the changed behaviour or failure is inspected and its material blind spots, followed by `## 🧪 Testing` for relevant suites and scenario outcomes. Put the icons before the titles and keep paragraph and bullet text plain. Report CI and applicable analysis together, tied to the tested head. Link detailed records instead of pasting logs.

When material, put `## Merge impact` last, after Testing and supporting Details. Explain reversibility and affected scope: what reverting restores, what remains, and which users, consumers or systems can be affected. Use `## ⚠️ Merge impact` when difficult to reverse. Name concrete consequences, such as deleted data or an external action that a code revert cannot undo. Routine reversible edits need no risk section.

Refine the language with the selected writing skill while preserving required format and evidence. If a decision trail is needed, use the existing show-me-your-work procedure rather than inventing a new log format.

## Validate and deliver

Run the project's body and section validators and inspect the rendered body using its existing publication tools. Review meaning separately: syntax checks cannot establish truth, evidence adequacy, access or visual usefulness. Complete when the body satisfies the project contract, supports its claims and each link is checked or its access limitation stated. Publish only within authorization, use body files instead of shell-interpolated prose, and verify the remote body after publication or revision. A local draft can finish with publication pending.

## Attribution

Adapted from [Matt Pocock's pr skill](https://github.com/mattpocock/skills/blob/main/skills/engineering/pr/SKILL.md), retrieved 2026-10-31, MIT; upstream credits Dex Horthy / Humanlayer's [show-me](https://github.com/humanlayer/skills/blob/main/plugins/show-me/skills/show-me/SKILL.md). See [LICENSE](LICENSE.txt). Project-specific commands and strict checks remain at their project owners.
