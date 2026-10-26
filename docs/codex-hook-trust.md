# Codex hook approval

## Requirements map

The installer and skill curator need one reusable command to inspect and approve Codex hooks after the owner accepts their scope. Source: the owner's request. The source owner is `skills/geppetto-adopt/scripts/codex-hook-trust.mjs`; the project installer distributes it to `.geppetto/bin/` and installed adoption skills.

- Inventory: use Codex `hooks/list`, including actual keys, hashes, enabled state, management and trust status. An empty selection or discovery error fails visibly.
- Consent: listing is read-only. `--approve` requires an explicit plugin, source file or key selection. Other hooks and unrelated settings retain their state. Disabled hooks stay disabled; managed hooks remain under their existing policy.
- Persistence: write the selected current hashes through `config/batchWrite`. Recheck the selection before writing and verify its hashes and trust status afterward. A later definition change requires another accepted approval.
- Lifecycle: run the installed Codex app-server without a model turn or hook execution, use bounded requests, and close the child on success, failure or timeout. Use hidden Windows launches and the existing CLI resolver.
- Delivery: adoption and skill curation point to this command. Installing files alone does not approve hooks. Project trust remains a separate Codex prerequisite.

## Verification

Synthetic CLI tests cover scoped approval, persistence, idempotence, unrelated settings, disabled/managed hooks, changed definitions, failed discovery and transport failures. A separate installed-CLI trial uses a temporary Codex home and harmless hook definitions; it must demonstrate untrusted → trusted → modified without touching personal approvals or starting a model turn.

## Observability

The command reports selected keys, commands, hashes, enabled state and trust status; JSON output retains warnings and the approval result. Missing Codex, unsupported APIs, discovery errors, changed selections and failed verification exit unsuccessfully. Approval status describes the definition Codex hashes, not the integrity of every script that definition may invoke or proof that a lifecycle event fired.
