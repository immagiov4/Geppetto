# Connect suggestions

Resolve the OpenRouter key through the machine's existing secret launcher. Check availability with `memory-hook.mjs --check-credential` or `skill-hook.mjs --check-credential` from the actual launcher; these commands print presence only.

Preserve configured models and retrieval settings. Factory settings live in `common.mjs`; local overrides live in `.geppetto/config.json`. Test requests with synthetic candidates, then inspect `.geppetto/hook-events.jsonl` for model calls, duration, injected bytes and cost. [Hook operation](../assets/templates/hooks/README.md) describes traversal and limits.
