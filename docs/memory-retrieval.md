# Recursive memory retrieval

The optional classifier selects allowed global/project buckets, reads selected indexes and repeatedly selects relevant child indexes or terminal pages. Links ending in `index.md` or `/` identify child indexes; aliases use the canonical target's name to determine whether to expand it. Relative links resolve from the containing index, and canonical paths keep every document inside its selected bucket. Each bucket's root index retains its configured identity. Private buckets remain outside automatic retrieval. Only index text is read for discovery; terminal page bodies are opened later by the agent.

All branches share one provider-call queue, deadline and spending reservation. `maxConcurrentRequests` defaults to one; an explicitly larger value permits sibling indexes and split request batches to run concurrently. `maxRequestBytes`, when configured, bounds the exact provider JSON body, including its schema. An indivisible oversized candidate fails with a diagnostic instead of silent truncation. Configuration and the model-specific evaluation remain owned by the [hook reference](../skills/geppetto-adopt/assets/templates/hooks/README.md).

## Observability

Each run records modelCalls, durationMs, injectedBytes, actual cost (or null when unknown), reservation identity, status and a redacted error in the local hook-event log. Requests that are queued after cancellation never call the provider. Unknown issued-call charges keep their reservation for reconciliation. Shared canonical pages are emitted once in stable order, and visited indexes prevent cycles.

## Verification

Synthetic end-to-end hook tests cover selected and ignored descendants, parallel siblings, cycles, duplicate leaves, canonical bucket boundaries, exact serialized byte limits, bucket and page batches, deadline cancellation and concurrent cost accounting. Injected HTTP transports exercise the real provider adapter without paid calls or personal memory. These tests prove the control flow and contracts; model retrieval quality and real latency belong to the separate [classifier evaluation](classifier-evaluation.md).
