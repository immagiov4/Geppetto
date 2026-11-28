---
name: geppetto-memory
description: "Memory: retrieve durable knowledge and decision rationale, save authorized facts or informal rationales without a better owner, or maintain the topic wiki."
---

# Memory

If `~/.geppetto/integrations.md` has a section for this skill, read it.

Bucket memory lives in one Git repository of Markdown (private when it holds personal material), cloned locally and declared in `~/.geppetto/config.json`. The memory repository holds knowledge; these update rules live in this skill.

1. **Resolve.** Use an explicit task destination first, then user `~/.geppetto/config.json` defaults overridden by project `.geppetto/config.json`. Resolve `repo`, `localPath` and linked `buckets`; a project bucket array takes precedence over its legacy `projectBucket`. Verify the checkout's remote identity. Complete when destination and linked buckets are known.
2. **Retrieve.** Read the root index and global preferences index, then relevant linked indexes and pages. From the memory repository root, search with `rg <pattern>`; `git log -p <page>` shows why a fact changed. Bucket names describe subjects; retrieve personal facts when relevant under the same access rules as other buckets. Recheck changeable facts, first those whose `verified` or `added` date is missing or oldest, and report their freshness. Complete when each used fact has an owner and evidence status. [Layout](references/layout.md) and [retrieval](references/retrieval.md) describe the index contract.
3. **Place.** Use `$geppetto-learn` to find the existing owner. Save generalizable lessons and decision rationale without another owner; consolidate events into lessons. Distinguish decisions, hypotheses and open questions; retain source, scope and rationale. Complete when each candidate has a justified destination or discard.
4. **Integrate.** Follow the requested repository, bucket and operation. Update the checkout and edit only the paths you own, following the [shared checkout](references/shared-checkout.md) rules. Update the existing page, reconcile contradictions and repair indexes. End changeable facts with their [provenance](references/layout.md#provenance). Keep credentials outside memory. New buckets declare `global` or `project` scope and a one-line description. Complete when the requested facts have one discoverable owner.
5. **Deliver.** Commit only your own paths, after confirming their staged diff, with a rationale and `Memory-Event: save`, `refactor` or `remove`, and push the commit in the same step together with earlier pending memory commits on that branch. If the installed hook already pushed, verify the destination revision. Recover a rejected push as the shared checkout rules describe. If recovery fails, report the cause and list the pending commits. Repositories without a remote stay local. Weekly [maintenance](../geppetto-adopt/assets/templates/jobs/maintain-memory.md) follows the same delivery procedure. Complete when the authorized commits are verified at their intended destination.
