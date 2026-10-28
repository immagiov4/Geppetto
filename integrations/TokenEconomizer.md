# TokenEconomizer

Skills: tokeneconomizer, tokeneconomizer:status, tokeneconomizer:toolprune

[microsoft/TokenEconomizer](https://github.com/microsoft/TokenEconomizer) cuts coding-agent cost: it stops loading tools a repository never uses and redirects turns stuck on the same failure. Useful when many tools or MCP servers are loaded and tokens are paid.

Status: suggested.

## Install

Clone the repository to a persistent folder. Claude Code: `claude plugin marketplace add <absolute-clone-path>`, then `claude plugin install tokeneconomizer@tokeneconomizer`. Codex: `codex plugin marketplace add <absolute-clone-path>`, then `codex plugin add tokeneconomizer@tokeneconomizer`. Then `config set toolprune=on` and `config set microskills=off`: Geppetto owns learned facts.

## With geppetto-measure-it

Read its cost reports before claiming a saving.

## With geppetto-learn

Record a loop it reports as an agent signal on an open key.
