# Project choices

Reuse current configuration before asking questions. Present defaults as proposals in one grouped round; a default is accepted only through the applicable user decision channel.

| Choice | Proposed default |
| --- | --- |
| Documentation location/style | Existing owner and style; when absent, `docs/` with concise feature pages. Offer a reference repository if the maintainer wants examples. Infer structure, tone and update rules from authorized material. |
| Existing development system | Preserve it and map equivalent pillars. |
| Review engine | Bundled `code-review` plus `receiving-pr-reviews`; retain both unless the user chooses a replacement. |
| CI provider / ticket gate transition | Existing provider. With no ticket engine, record the transition `n/a`; PR merge remains the enforcement boundary. With an engine, agree its blocking step. |
| Observability format | Per-feature declaration and PR/ticket `## Observability`; template fields are editable. |
| Significant test documentation | Adjacent to tests; opt into per-feature `## Verification`. |
| Unit coverage | `unitCoverage: "behaviour"`; `"full"` includes design-neutral unit coverage. |
| Budgets and unattended scope | Empty grants; user decides capabilities, scope, period, cost and expiration. |
| Memory | Recommended: one private Git repository of Markdown buckets, declared once in `~/.geppetto/config.json`; the project links its own bucket. Default: reuse the user-level repository when present, otherwise offer to create one. |
| Linked memory buckets | Preserve existing `memory.buckets`; accept `projectBucket` as one legacy link. Otherwise propose the project's matching bucket. Ask which nonprivate buckets to link for full-index injection; Global buckets are always listed. Private retrieval stays manual under explicit access scope. |
| Extra packs | Preserve installed packs and record resolved companions in `packs`. |
| Optional retro | `declined`. Offer once: “Enable retro for requested session analysis?” |
| Periodic learning / skill curation / memory jobs | Each `declined`. Offer once per job: “Schedule this scoped maintenance pass under a separate unattended grant?” |
| Semantic hooks | Each `declined` and disabled until its explanation, authorized benchmark and explicit keep decision in [semantic hooks](semantic-hooks.md). Offer once: “Compare this hook on your project's cases before deciding whether to enable it?” |
| Per-message memory classifier | `declined`, with `hooks.memoryClassifier.enabled: false`. Offer the OpenRouter two-stage page suggestions through the same explanation, benchmark and keep-decision flow; session-start bucket listing works without it. |
| End-of-turn learning nudge | Enabled by default under `hooks.learnNudge`; deterministic, with no handler model call or key. Inspect the shipped [thresholds, rationale and continuation cost](../assets/templates/hooks/README.md). This is separate from semantic hooks and periodic jobs. |

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
  "hooks": {"learnNudge": {"enabled": true, "benchmark": null}, "memoryClassifier": {"enabled": false, "benchmark": null}},
  "memory": {"buckets": ["my-app"]}
}
```

Populate `pillars` with `installed|declined|n/a` and reasons in the adoption report; retain each recorded refusal on reruns. Semantic hook entries start with `enabled: false` and `benchmark: null`; the deterministic `hooks.learnNudge` uses its own enabled default and thresholds. A project may make `Verification` required by adding it to `sections.featureDocs`. Resolve memory through `$geppetto-memory`, including explicit task paths and privacy/publication scope.
