# TokenEconomizer

Skills: tokeneconomizer, tokeneconomizer:status, tokeneconomizer:toolprune

Tracks unused tools and recurring loops through harness hooks. Geppetto keeps ownership of evidence, skill learning and memory.

Status: suggested. [Upstream implementation and installation](https://github.com/microsoft/TokenEconomizer) describe the mechanisms; local benefit requires project measurements.

## Install

After an explicit yes, clone the upstream repository to a persistent tools folder. Claude Code: `claude plugin marketplace add <absolute-clone-path>` then `claude plugin install tokeneconomizer@tokeneconomizer`. Codex: the same marketplace command with `codex`, then `codex plugin add tokeneconomizer@tokeneconomizer`. Review hooks through the harness's trust controls. Use its `config set toolprune=on` and `config set microskills=off` commands; keep micro-skills off so Geppetto remains the knowledge owner. Check upstream supported harness versions before installation. Model and tier choices remain those authorized for the session.

## With geppetto-measure-it

Inspect TokenEconomizer's recorded tool use and actual cost before claiming savings. Keep token, elapsed-time and coverage gaps explicit.

## With geppetto-learn

Use repeated loop evidence as an agent-sourced signal, reusing an open key. Let Geppetto's distinct-session threshold decide when learning acts.

## With geppetto-adopt

Verify tool pruning is enabled and micro-skills are disabled; retain the harness's existing tools and hook authorization.
