---
name: geppetto-authorize
description: "Check OpenRouter API key availability and an optional user-set spending cap."
---

# Paid API requests

An OpenRouter key supplied during installation enables skill and memory suggestions. Resolve it from the process environment or the machine's existing secret launcher.

`authz.mjs` accounts only for paid OpenRouter calls. Check with `check <capability> --provider openrouter --cost <USD|none>`, reserve before the request with `reserve ... --id <request-id>`, and record its cost with `settle --id <request-id> --actual <USD>`. `list` shows API usage.

An optional `api.spendCapUsd` in `~/.geppetto/config.json` limits cumulative machine spending. With a cap, callers supply a maximum; interrupted requests retain it.

Subscription CLIs run through their existing accounts. Their execution procedure belongs to [learning](../geppetto-learn/references/ingestion.md).
