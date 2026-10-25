# Sources and adaptation

Sources consulted on October 12, 2026. Links point to the revisions studied so the adaptation remains comparable as the projects change.

## e-bash

Source: [skill-learning in OleksandrKucherenko/e-bash](https://github.com/OleksandrKucherenko/e-bash/blob/26d905b30c65d57c6707049c8ace9aba2d20fe61/.claude/skills/skill-learning/SKILL.md), including its references on recognizing lessons, validation, and contributions. MIT License; the license text is preserved in [LICENSE.txt](../LICENSE.txt) inside this bundled skill.

The adaptation preserves the search for reusable lessons, comparison with existing instructions, evidence validation, and retention of valid knowledge. It reframes validation criteria around the scope of the change: a reproduced error can justify a focused correction after a single episode, while a generalization requires verification under its stated conditions; tool popularity remains a research clue rather than proof that a procedure is valid. It also assigns publication rules to the destination repository.

## Hermes

Sources: [experience review](https://github.com/NousResearch/hermes-agent/blob/f594424e58f18ebc2607decaa72f300e0a26a24b/agent/background_review.py), [curator](https://github.com/NousResearch/hermes-agent/blob/f594424e58f18ebc2607decaa72f300e0a26a24b/agent/curator.py), and the [`/refine` command](https://github.com/NousResearch/hermes-agent/blob/f594424e58f18ebc2607decaa72f300e0a26a24b/website/docs/reference/slash-commands.md). This adaptation's instructions are rewritten for Codex; these sources document the mechanisms studied.

In Hermes, `/refine` starts a review against a conversation snapshot, optionally guided by a focus. The code prioritizes updating a relevant loaded or existing skill and requires a fresh read before writing. Collection review considers consolidation, provenance, protections, and recoverability; in the code studied, model-driven consolidation is optional and disabled by default.

Here those methods become procedures executable with Codex files and tools: reading before editing, finding the procedure's owner, topical references, caller checks, and recoverable copies for authorized consolidation. Personal preferences remain scoped to their audience, and writes follow the environment's authorizations. Activation uses normal Codex skill selection or `$skill-learning-patterns`; recurring execution requires its own request and configuration.
