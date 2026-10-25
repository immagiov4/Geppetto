# Retrieval trace

For a requested retrieval proof, retain the question, injected listing/indexes or indexes actually read, pages chosen, supported answer and source. Example with synthetic workspace preferences:

| Trace field | Observed content |
| --- | --- |
| Question | Where do local verification artifacts belong? |
| Listing and indexes | Session injection: location plus Global/Project descriptions from root `index.md`, including Global preferences; linked `buckets/preferences/index.md` injected in full. Direct fallback: read those two indexes. |
| Optional hint | A classifier suggests `buckets/preferences/workspace.md` with a workspace-location reason; the agent checks relevance. |
| Pages chosen | `buckets/preferences/workspace.md` |
| Answer | Use `<workspace>/evidence/<task>/`, one folder per task. |
| Source | `buckets/preferences/workspace.md:12`, at the inspected Git revision, with the preference's recorded date and scope. |
| Evidence status | Agent-selected pages read in this session; directory ownership checked locally. |

Use the real revision, injected sources, selected hints and actual page reads from the task; record which retrieval path ran. A same-session trace demonstrates that path with its existing context; evaluate an automatic selector or independent retrieval separately. An empty bucket index is valid: report no relevant pages and continue only through other allowed owners. Recheck mutable facts and preserve privacy boundaries throughout the trace.
