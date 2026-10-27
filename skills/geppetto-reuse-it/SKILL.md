---
name: geppetto-reuse-it
description: "Reuse existing primitives before adding machinery. Use before a new tool, hook, prompt path, special case or natural-language heuristic."
---

# Reuse

Before adding a capability, prompt path or exception, inspect the existing skills, scripts, hooks, Git and harness tools that could compose it. Prefer a few reusable capabilities: a correction in their shared owner improves every caller. Search the current repository and trace actual callers before deciding that a new owner is needed. Keep established behaviour and validation when reusing or moving code.


Put a mechanically verifiable contract in a script or gate. Send meaning and context to an appropriately validated classifier or language model. A Markdown heading parser can prove that a section exists; it cannot establish that a feature's observability is adequate. Design semantic heuristics carefully and benchmark their real cases through `$geppetto-measure-it`, including omissions, noise and cost, before relying on them.

Introduce a state machine with a reducer only for a well-defined process that an ordinary skill has demonstrably failed to enforce. Choose modules where boundaries improve quality and permit independent work, rather than adding wrappers or files without a responsibility. Reuse an existing scheduler for periodic ordinary agent requests.

Complete when the proposed addition has a demonstrated gap, a clear owner, and a comparison with an existing composition. If a composition satisfies the contract, use it and verify the resulting behaviour. The principle remains complete even when another installed development pack teaches the same idea.
