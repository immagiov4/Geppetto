# Classifier evaluation

Compare each optional classifier with the path the project already uses, on the models and scope the maintainer approved. The shipped recursive classifier is memory retrieval. Skill selection and requirements screening are evaluation targets only when those integrations exist on the machine; this pack does not ship them as Geppetto owners. The three baselines are: the skill catalog and router; direct memory-index navigation; and ordinary source search with caller tracing. Before proposing a configuration change, find the hooks, global jobs, credential sources and invocation policy that already exist. Reuse an equivalent integration when one is configured. Record whether that integration is actually running. A file on disk is not that record.

## Observability

**Skill selection.** When a selector is present, compare the existing catalog and router with suggestions for the current request. Include a skill that would help but is unused, a skill that is explicit-only, an ambiguous request, and a request that needs no skill. Measure suggested-skill relevance, omissions, unnecessary activations, actual injected context, added latency and provider-reported cost. Suggestions alone do not suppress a host catalog.

**Memory retrieval.** Compare direct index navigation with recursive suggestions, on shallow, nested, branching and irrelevant topics. Include a large index that requires request splitting. Measure terminal-page relevance, missed branches, model calls, exact request bytes, injected bytes, end-to-end latency and cost. Owners are on the [system map](system-map.md); the walk is [recursive memory retrieval](memory-retrieval.md).

**Requirements screening.** When a screen is present, compare ordinary source search and caller tracing with ranked reading targets, on the same approved repository questions. Measure useful paths found and missed, irrelevant targets, added latency, context and cost. Reading the source remains authoritative.

Use synthetic public fixtures first. Match inputs, source revision, selected model, concurrency and request limits between the two sides of a comparison. Record a failure separately, and inspect the final outcome as well as the intermediate suggestions. Human-only setup follows [classifier setup](../skills/geppetto-adopt/references/classifier-setup.md): reuse the host secret store, or a Wizard generated for the missing steps. Verify an existing key in the environment that actually launches the hooks, then reuse it.

This comparison records evidence for tuning. Record the results and show them. Do not use them as an activation gate.

A paid call needs recorded data-and-spending authorization. Standing consent is recorded once and is what keeps the classifier able to run on ordinary requests, together with its key and selected settings. Consent for a one-off comparison covers only that comparison and does not create standing consent. Reserve a bounded amount when the grant sets a cap. An explicitly unlimited grant (`budget_usd=none`) permits an unbounded reservation. A grant with neither form is not ready for a paid call.
