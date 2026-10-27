---
name: geppetto-memory
description: "Memory: retrieve durable knowledge and decision rationale, save authorized facts or informal rationales without a better owner, or maintain the topic wiki."
---

# Memory

Bucket memory lives in one Git repository of Markdown (private when it holds personal material), cloned locally and declared in `~/.geppetto/config.json`. The memory repository holds knowledge; these update rules live in this skill.

1. **Resolve.** Use an explicit task destination first, then user `~/.geppetto/config.json` defaults overridden by project `.geppetto/config.json`. Resolve `repo`, `localPath` and linked `buckets`; a project bucket array takes precedence over its legacy `projectBucket`. Verify the checkout's remote identity. Complete when destination and linked buckets are known.
2. **Retrieve.** Read the root index and global preferences index, then relevant linked indexes and pages. Use the injected listing or the local checkout. The `private` bucket requires an explicit user request. Classifier suggestions are reading hints: inspect the page and recheck changeable facts. Complete when each used fact has an owner and evidence status. [Layout](references/layout.md) and [retrieval](references/retrieval.md) describe the index contract.
3. **Place.** Use `$geppetto-learn` to find the existing owner. Save durable facts and informal decision rationale here when no script, skill or project document owns them. Distinguish decisions, hypotheses and open questions; retain source, scope and rationale. Complete when each candidate has a justified destination or discard.
4. **Integrate.** Follow the requested repository, bucket and operation. Inspect local and remote changes, update the existing page, reconcile contradictions and repair indexes. Keep credentials outside memory. New buckets declare `global` or `project` scope and a one-line description. Complete when the requested facts have one discoverable owner.
5. **Deliver.** When the task requests commits, commit each modified bucket with its index, rationale and `Memory-Event: save`, `refactor` or `remove`. Publish when requested and verify the destination revision. For periodic maintenance, use the [maintenance prompt](../geppetto-adopt/assets/templates/jobs/maintain-memory.md) and deduplicate facts while preserving decision rationale. Complete when the requested local or published artifact is verified.
