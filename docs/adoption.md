# Geppetto self-adoption

This repository runs the pack it publishes. Source skills in `skills/` stay authoritative. Git ignores the local skill copies under `.agents/skills` (agents and Codex) and `.claude/skills`. `.geppetto/bin` is the copy that provides reproducible project enforcement. The installer records ownership in an ignored local manifest. How the copy is produced is on the [system map](system-map.md).

The project writes documentation in English, uses behaviour tests, bundles [code review](../skills/code-review/SKILL.md) and keeps its GitHub Actions matrix. The check to run is `npm run check`, described in [development](development.md). Standing policy: an optional feature with no recorded decision stays pending and disabled; a choice already recorded is kept.

Repository checks do not establish hook trust in an external harness, or a spend limit on the provider account.

## Observability

The public repository contains no personal memory text, keys, private hook receipts or automation prompts. After a source change, refresh with the install commands in [development](development.md), then run `node skills/geppetto-adopt/scripts/audit.mjs --project . --verify`.
