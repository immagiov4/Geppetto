# OpenRouter classifier setup

Use this branch for an uncovered [semantic hook](semantic-hooks.md). Record the accepted standing data-and-spending scope once; secure key delivery and selected settings complete readiness. Benchmark results are recorded evidence rather than a permanent-activation gate.

## 1. Verify the execution environment first

Identify the actual hook command, working directory, user, launch mechanism and environment source, including any existing secret-store wrapper. Inspect source names and availability only, never secret values. Reuse that configured mechanism; a secret already available to the hook requires no new account or key.

For the memory classifier, run the existing hook entry point through the **same launcher and environment** used by the hook, substituting this no-network probe for the event invocation:

```sh
node <adopt>/scripts/memory-hook.mjs --check-credential
```

After installation, use the installed `.geppetto/bin/memory-hook.mjs` path. It reads no stdin, config, `.env` or memory content, makes no provider call, and writes no files. Exit 0 reports `credential: "present"`, `source: "process-environment"`; exit 1 reports missing. Both report `providerAuthentication: "not-verified"`. A present key is availability evidence only, not validity, budget, consent or hook trust. An unrelated interactive shell is not evidence about a desktop/daemon hook. If the actual launcher cannot run the probe, record availability as unverified and leave setup pending.

The memory classifier consumes `OPENROUTER_API_KEY` from its process environment. A `.env` file alone does not deliver it. If the existing host or secret manager injects this variable, reuse it. If the source exists but is absent from the child, repair only its authorized existing injection path and probe again. Do not read or copy its value into a command argument, report or committed config. Probe other selected hooks through their own provider/setup owner; this probe establishes nothing about a separate process.

Complete when the exact hook launch context reports availability, or a concrete missing/unverified prerequisite is recorded. Skip the next section when a credential is already available.

## 2. Guide only missing human steps

Prefer the host's private secret-entry facility when it can deliver directly to the identified execution environment. Otherwise resolve `wizard` through the existing [companion resolution](integrations.md), project first, then user/global or installed plugin. Read the resolved `SKILL.md` and its template; record provenance in `packs`. Do not bundle a second wizard implementation merely to duplicate an installed companion. If unavailable, report the blocked branch and ask whether to install it under separate authorization, or let the human complete the steps manually. Keep the experiment pending when secure entry or delivery is unavailable.

Build stages dynamically from the observed machine and missing prerequisites. Show the stages and destination mechanism for approval first. Use the resolved Wizard template's URL-opening and hidden-entry helpers, not a parallel credential collector. A generated Wizard is temporary and human-run; do not run it end-to-end as the agent. Respect [silent process execution](processes.md), and open browser UI only when the human explicitly starts the interactive setup.

The missing-key human journey is:

1. Open [OpenRouter](https://openrouter.ai/) and sign up or log in. The human completes authentication privately.
2. Open [API keys](https://openrouter.ai/settings/keys) and create a key. Confirm the current dashboard labels before generating click instructions; do not invent them. Key creation is not permission to fund an account or make calls.
3. Enter the key through the host's private facility, or the installed Wizard's hidden secret prompt. Agree the storage destination outside committed configuration. It must feed `OPENROUTER_API_KEY` to the hook's actual launcher through its existing environment/secret mechanism. Do not silently fall back to a `.env` upsert when no existing loader connects it to that process.
4. Rerun the no-network probe through that same launcher to verify key availability. Resume comparison after availability and the data/spending grants below are established.

Consult the provider's [quickstart](https://openrouter.ai/docs/quickstart) for current account/key instructions. OAuth PKCE is a separate evaluation of authentication flow and credential storage, not a fallback introduced by this flow.

## 3. Record consent and measurement

Return to the [comparison owner](semantic-hooks.md#setup-and-comparison). Before real requests, record the accepted data-and-spending grant once. Select model, traversal settings and any optional cap through the existing owner; this setup flow supplies no thresholds or spending cap. The classifier operates when the key, settings and continuing grant are present. One-off benchmark consent covers only that comparison.

Show and record benchmark results when available in `hooks.memoryClassifier.benchmark`. An absent result remains visible as `null` and does not block authorized operation. Record explicit refusals and preserve them on reruns. Give one actionable item for a missing key, model/settings or standing grant.

## Observability

Report source mechanism, actual launch context and `present|missing|unverified`, never values or a full environment dump. Report provider authentication separately, benchmark results/reference or `not run`, and final kept/declined/pending state. Repository fixtures cover existing and missing-then-delivered synthetic credentials through a child hook and injected provider without network. They do not prove a live host's secret integration or OpenRouter authentication.
