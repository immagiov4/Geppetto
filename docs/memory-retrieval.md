# Recursive memory retrieval

At session start the memory hook lists every configured bucket and the full indexes of the project-linked buckets. The agent follows those links itself. That path needs no classifier. This page is the optional path: a classifier that suggests pages by walking indexes before the agent opens them.

The classifier selects the global and project buckets it is allowed to read. It reads each selected index and repeatedly selects a relevant child index or a terminal page. A link ending in `/` is read as `index.md`. A selected link whose resolved file name is `index.md` is a child index and is expanded. Any other selected Markdown link is a terminal page. A symlink is expanded from its canonical path, not from the link text. Relative links resolve from the index that contains them. The canonical path must stay inside the selected bucket. Each bucket's root `index.md` must resolve to the identity configured for that bucket, so a symlink cannot move it. Private buckets stay outside automatic retrieval. An index already visited is not walked again, so a cycle stops. A page reached by more than one path is emitted once, sorted by canonical id. Discovery reads index text only. The agent opens a terminal page body later.

Every branch shares one provider-call queue, one deadline and one spending reservation. When the deadline expires, the shared abort signal stops scheduling new calls, drops queued requests without calling the provider, and logs an error. `maxConcurrentRequests` defaults to 1, so an existing configuration stays serial. An explicitly larger value lets sibling indexes and split request batches run at the same time. When `maxRequestBytes` is set, candidates are split so each provider JSON body, including its schema, stays within that byte limit. A single candidate that cannot fit fails with a diagnostic and is not truncated. If the cap is absent, requests stay unsplit. Settings, defaults and the grant that allows a run are in the [hook reference](../skills/geppetto-adopt/assets/templates/hooks/README.md).

## Observability

Each run records `modelCalls`, `durationMs`, `injectedBytes`, actual cost (or null when unknown), reservation identity, status and a redacted error in the local hook-event log. An issued call whose charge is unknown keeps its reservation for reconciliation.

## Verification

Synthetic end-to-end hook tests cover selected and ignored descendants, parallel siblings, cycles, duplicate leaves, canonical bucket boundaries, exact serialized byte limits, bucket and page batches, deadline cancellation and concurrent cost accounting. Injected HTTP transports exercise the real provider adapter without paid calls or personal memory. Those tests establish the control flow and the contracts. Model retrieval quality and real latency belong to [classifier evaluation](classifier-evaluation.md).
