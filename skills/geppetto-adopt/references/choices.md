# Project choices

Reuse current configuration and complete [existing-automation discovery](#verify-before-asking) before asking questions. Present only uncovered choices or concrete gaps in one grouped round; a default is accepted only through the applicable user decision channel. An optional feature with no recorded answer is pending: explain it and ask, keeping it disabled until accepted. Record `declined` only for an explicit refusal, and preserve that refusal on reruns. Leave unanswered choices out of `pillars` and report them as pending.

| Choice | Proposed default |
| --- | --- |
| Documentation location/style | Existing owner and style; when absent, `docs/` with concise feature pages. Offer a reference repository if the maintainer wants examples. Infer structure, tone and update rules from authorized material. |
| Existing development system | Preserve it and map equivalent pillars. |
| Review engine | Bundled `code-review` plus `receive-work-feedback`, using an available CLI, application or harness verified during adoption. Preserve a working project choice. |
| CI provider / ticket gate transition | Existing provider. With no ticket engine, record the transition `n/a`; PR merge remains the enforcement boundary. With an engine, agree its blocking step. |
| Observability format | Per-feature declaration and PR/ticket `## Observability`; template fields are editable. |
| Significant test documentation | Adjacent to tests; opt into per-feature `## Verification`. |
| Unit coverage | `unitCoverage: "behaviour"`; `"full"` includes design-neutral unit coverage. |
| Budgets and unattended scope | Record accepted standing consent once. Run and USD caps are absent unless the owner sets them; publication and private/transcript access stay separately scoped. |
| Memory | Recommended: one private Git repository of Markdown buckets, declared once in `~/.geppetto/config.json`; the project links its own bucket. Default: reuse the user-level repository when present, otherwise offer to create one. |
| Linked memory buckets | Preserve existing `memory.buckets`; accept `projectBucket` as one legacy link. Otherwise propose the project's matching bucket. Ask which nonprivate buckets to link for full-index injection; Global buckets are always listed. Private retrieval stays manual under explicit access scope. |
| Extra packs | Preserve installed packs and record resolved companions in `packs`. |
| Optional retro | Ask once: “Enable retro for requested session analysis?” |
| Event-driven signal learning | Enabled when a subscription CLI is authenticated. Ask once, default yes: “Allow signal learning with project file tools and local branch commits?” Record the accepted answer with `learning-setup.mjs --project <root> --accept`. Codex uses `gpt-6.1-sol`, default service tier; Claude is the alternative when Codex is absent. See the [native host and recovery contract](../../geppetto-learn/references/ingestion.md). |
| Learning write review | `hooks.signalLearning.writeApproval: false`: commit improvements on an isolated local branch. Set true to retain staged changes for review. |
| Periodic learning | Explain how recurring signals become measured procedure improvements; ask whether to schedule it. |
| Periodic skill curation | Explain how the pass reviews skill overlap and stale instructions; ask whether to schedule it. |
| Periodic memory maintenance | Explain that the pass deduplicates facts, reconciles contradictions, removes obsolete material and repairs indexes; ask: “Would you like periodic memory maintenance enabled?” After acceptance, use the [job procedure](../../geppetto-learn/references/jobs.md) to agree on cadence, buckets, permitted writes and publication, then test before activation. |
| Semantic hooks | Explain the uncovered hooks through [semantic hooks](semantic-hooks.md), preserve refusals and record standing consent once. Measurements remain visible alongside configuration. |
| Per-message memory classifier | Enabled when the OpenRouter key, selected model/settings and standing user/project grant exist. Ask for data and spending scope once; record the comparison when available. A benchmark is evidence, not an activation gate. Without a key, audit gives the one action to supply it; session-start bucket listing works independently. |
| Internal learning reminder | Enabled by default under `hooks.learnNudge`; deterministic, with no handler model call or key. Inspect the shipped [thresholds, rationale and reflection cost](../assets/templates/hooks/README.md). This is separate from semantic hooks and periodic jobs. |

## Verify before asking

The audit reports candidate locations, not equivalent behaviour or scheduler enablement. Inspect the available project-local and user/global hook configurations, installed plugins, recorded Geppetto choices and scheduler job definitions/state before offering hooks or maintenance. Include other available schedulers such as host automations or OS jobs when relevant. Inspect only authorized configuration, not credential stores or secret values.

For each candidate, record its identifier/source, purpose and implementation, enabled state, project/user scope, event or cadence/timezone, execution environment and authorization references. Verify behaviour and scope, not just a matching name. Reuse a verified equivalent instead of installing, offering or scheduling it again. Preserve its current consent and decline decisions; an existing job's presence is not a grant to broaden its scope. Follow the existing [job procedure](../../geppetto-learn/references/jobs.md) for accepted gaps.

Mark inaccessible sources or uncertain equivalence as unverified, not absent. Report that concrete gap and request only the access or decision needed to resolve it; do not create a duplicate while it remains unresolved. A disabled equivalent, expired authorization or missing scope is a specific repair choice, not permission to re-enable or replace it. Complete when the adoption report names the sources checked, reused equivalents, preserved refusals and uncovered or unverified choices before the grouped questions.

## Record choices

Configuration follows this shared shape; retain unrelated keys. Paths and bucket name are chosen per project. The memory URL/path below are the maintainer's configuration, not a universal destination.

```json
{
  "version": 1,
  "docs": {"root": "docs", "style": "feature pages", "referenceRepo": null},
  "sections": {"pr": ["Observability"], "featureDocs": ["Observability"], "optional": ["Verification"]},
  "review": {"engine": "code-review"},
  "unitCoverage": "behaviour",
  "packs": [],
  "pillars": {},
  "hooks": {"learnNudge": {"enabled": true, "benchmark": null}, "signalLearning": {"enabled": true, "benchmark": null, "host": "codex", "billing": "subscription", "provider": "openai", "boundary": "project-file-tools", "writeApproval": false, "hosts": {"codex": {"model": "gpt-6.1-sol", "serviceTier": "default", "sandbox": "workspace-write", "tools": ["Read", "Edit", "Write", "Glob", "Grep"]}}}, "memoryClassifier": {"enabled": true, "benchmark": null}},
  "memory": {"buckets": ["my-app"]}
}
```

Populate `pillars` with `installed|declined|n/a` and reasons in the adoption report; retain each recorded refusal on reruns. Learning and memory classification default enabled when prerequisites and accepted standing consent are present; audit names a missing prerequisite with one actionable line. `benchmark: null` records absent measurement without preventing authorized operation. A project may make `Verification` required by adding it to `sections.featureDocs`. Resolve memory through `$geppetto-memory`, including explicit task paths and privacy/publication scope.
