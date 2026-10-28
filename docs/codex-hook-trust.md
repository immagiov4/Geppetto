# Codex hook approval

## Requirements map

The installer and skill curator need one reusable command to inspect and approve Codex hooks after the owner accepts their scope. Source: the owner's request. The source owner is `skills/geppetto-adopt/scripts/codex-hook-trust.mjs`; agents resolve it from the installed plugin or adoption skill.

The command inventories current hook keys and hashes, writes only selected enabled definitions with `config/batchWrite`, and verifies their trust afterward. Explicit plugin, source or key selection keeps unrelated and managed hooks intact. Transport errors and changing definitions fail the operation.

## Verification

Synthetic CLI tests cover scoped approval, persistence, idempotence, unrelated settings, disabled/managed hooks, changed definitions, failed discovery and transport failures. A separate installed-CLI trial uses a temporary Codex home and harmless hook definitions; it must demonstrate untrusted → trusted → modified without touching personal approvals or starting a model turn.

## Observability

The command reports selected keys, commands, hashes, enabled state and trust status; JSON output retains warnings and the approval result. Missing Codex, unsupported APIs, discovery errors, changed selections and failed verification exit unsuccessfully. Approval status describes the definition Codex hashes, not the integrity of every script that definition may invoke or proof that a lifecycle event fired.
