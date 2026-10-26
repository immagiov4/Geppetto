# Semantic hooks

Read [existing-automation discovery](choices.md#verify-before-asking) before offering anything. Reuse a verified equivalent and its recorded decision; discuss only an uncovered choice or concrete gap. Explain each uncovered hook separately, keeping recorded declines across reruns.

| Optional experiment | Explain to the maintainer |
| --- | --- |
| Skill selector, `hooks.skillSelector`, also called Bridge/System 1 | The bundled `skill-hook.mjs` suggests relevant skills on each request using the existing Mercury selector's decision questions. With many installed skills, the owner may choose explicit invocation and use these suggestions alongside the router. Compare missed procedures, irrelevant suggestions, latency, cost and loaded context on the user's tasks. Reuse an already active equivalent and avoid running both selectors. See [setup](../assets/templates/hooks/README.md#skill-suggestions). |
| Memory-page classifier, `hooks.memoryClassifier` | Defaults to Perplexity `pplx-decider-flash-v1.2` through OpenRouter's typed Decisions API to suggest relevant indexed pages per message. The agent still opens and judges pages. Measure useful supported facts found, privacy boundaries, noise and added context. Deterministic session-start bucket listing and linked indexes work without a key or classifier. |
| Requirements screen | Ranks candidate source files before discovery. Measure missed paths found; source reading and caller tracing still establish relevance. Use its existing [setup and evaluation owner](../../requirements-blast-radius/references/screen.md). |

A feature is enabled when its prerequisites and recorded consent are present. Ask about each uncovered scope once in the adoption round and preserve explicit refusals. Memory classification needs the OpenRouter key, selected settings and standing user/project data-and-spending grant; it has no default USD cap. The selector and requirements screen follow their owning implementations. Existing equivalents retain their verified state and consent. Record measurements and show their results; a missing benchmark is not a memory-classifier activation gate.

## Skills and routing

Adapt the existing [router template](../assets/templates/AGENTS.md) rather than replacing the project's instructions. Register personal skills and extra skill packs using the harness's existing discovery directories and `packs`. Add a conditional row in the project's `AGENTS.md` for each relevant owner, for example:

```markdown
| When | Where |
| --- | --- |
| Changing our deployment scripts | `$my-deployment-skill` |
| Working in the billing service | [billing router](services/billing/AGENTS.md) |
```

Resolve the routing targets and keep the agent free to discover additional skills beyond the suggested set. For a large catalog, offer explicit invocation with classifier suggestions alongside automatic invocation and manual selection. Compare the catalog descriptions, suggestions and skill bodies actually loaded in each configuration to measure their context cost.

## Setup and comparison

After setup is accepted, follow [OpenRouter setup](classifier-setup.md). Detect an existing credential before asking for one, verify availability through the actual hook launch environment, and skip account/key stages when it is present. Reuse the host's private entry facility or resolve an installed Wizard for human-only steps. Keep credentials outside chat, committed configuration, signals and reports.

Read `$geppetto-measure-it`; route paid calls through `$geppetto-authorize`. Record the accepted standing data-and-spending scope once, including any owner-selected cap. Build a project-specific comparison on authorized real cases with and without the hook, including omissions, noise, latency, reported cost and added tokens. Record cases, versions and limits so the result can be repeated, then show the results and retain their reference through [project choices](choices.md). The comparison measures the feature; the key, settings and grant determine memory-classifier readiness. Consent to a one-off benchmark alone does not grant continuing operation.

For memory, compare direct injected-index retrieval with classifier-assisted retrieval on the same authorized questions and bucket indexes, including Global preferences and project links. Record suggested pages actually opened and useful supported facts found. Consent to local memory reads does not authorize sending message/index context to OpenRouter. Preserve private-index exclusion and scoped access; hints grant no access.

## Signal learning

**Signal learning (`hooks.signalLearning`)** assesses project signals and investigates reusable workflows, verified fixes, user corrections or recurring causes through the [existing learning owner](../../geppetto-learn/references/ingestion.md). Adoption offers standing subscription consent once, default yes. Authenticated Codex uses `gpt-6.1-sol` and the default service tier; Claude is the alternative when Codex is absent. There is no default run or USD cap. `writeApproval` defaults false; true retains staged changes for review. Native acknowledgement, exclusive signal ownership, recursion protection and separate publication authority remain required.

## Hook patterns to consider

When adoption or learning identifies a gap, consider these patterns after inspecting the harness's native capabilities and existing hooks. For each candidate, identify the trigger, the feedback the agent receives and the comparison that would justify retaining it.

For tool-call timings and error statistics, follow [agent tool observability](../../geppetto-x-ray/SKILL.md#agent-tool-observability) to inspect native records and existing archives before proposing telemetry integration.

- **After an edit:** run the affected type check or tests and return actionable failures beside the tool result. [Hook events](https://code.claude.com/docs/en/hooks#posttooluse).
- **Before a command:** reject a destructive operation or an edit to a protected file, with a reason the agent can act on. [Protected files](https://code.claude.com/docs/en/hooks-guide#block-edits-to-protected-files). In case of a state machine, you can reject forbidden state operations in a certain state, and so on. Be creative :D
- **Before completion:** verify the result against the original request and return to unfinished work. [LangChain's verification example](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering).
- **During repeated edits:** count changes to the same file and suggest reconsidering the approach when the agent keeps circling. [LangChain's loop detector](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering).

## Observability

Report discovered equivalents and gaps, per-hook pending/declined/kept state, credential source mechanism and hook-process availability without values, and benchmark reference/results or `not run` with its reason. Credential presence is not authenticated provider access. Keep failed or interrupted setup pending and disabled, retaining safe failure evidence and reconciling any spending through its existing ledger.

Passive transcript reading and a reducer/state-machine process remain experiments requiring replay evidence. Calibrate any scoring threshold instead of shipping the diagram's `>0.75` example as policy. Transcript access needs a separate scoped grant. Introduce a reducer only after an ordinary skill fails to enforce a specific well-defined process.
