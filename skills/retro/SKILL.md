---
name: retro
description: "Examine a development session and propose improvements to the agent's tools, checks and instructions."
---

# Retro

At the user's request, identify agent-environment improvements that make later sessions more reliable. Start from errors and friction observed in the session.

## Procedure

1. Read `$writing-for-agents` to assess agent instructions. Use installed `$writing-for-humans` to present conclusions; see [optional integrations](../geppetto-adopt/references/integrations.md) for availability.
2. Examine the specified session's primary sources: conversation, logs, commands, results, file differences and user decisions. Without a reference, use the current session. For an earlier session, locate available logs and read relevant portions; redact credentials and personal data in quotations. For a chat sample, first apply requested filters (product, topic and period), then select the requested count in a stated order. Verify relevance in messages, retain a chat inventory and state coverage limits. Exclude empty chats and technical duplicates of the same activity from the count; use linked conversations as evidence of the same episode.
3. Search for improvements in the categories below. For each candidate, check project instructions, existing tools and the owner of the affected rule or check.
4. Present candidates by observed consequence and usefulness. For each, state the referenced episode, evidence-supported cause, proposed change, expected benefit and relevant cost or limitation. Distinguish observations from hypotheses. If evidence is insufficient, name the check that would allow a decision.
5. A retrospective request authorizes analysis and proposals. Apply changes when the user authorizes implementation; respect that authorization's scope for files, configuration, access and publication.

## Categories

- **Orientation:** when finding information took repeated attempts, assess a targeted pointer to the relevant document or entry point.
- **Automated checks:** read project verification commands and CI configuration first. An existing disconnected or broken check may be the cause. Propose the smallest check that catches an observed error; assess absent checks against concrete risk and cost.
- **Code rules:** distinguish mechanical errors from decisions requiring judgment. For mechanical errors, prefer a deterministic check in existing tools. For judgment, clarify the rule at its owning document and state how review should assess it.
- **Shared instructions:** inspect `AGENTS.md`, applicable global instructions and any `CLAUDE.md`. Assess targeted pointers when a long catalogue occupies every session's context. Preserve user authority and preferences.
- **Tool cost:** look for repeated calls or output too broad for the question; propose a more targeted read or reuse of an available tool.
- **Ineffective instructions:** compare the rule with observed behaviour. Clarify the point that leads to the wrong decision, keeping each meaning at one owner.
- **Information access:** when necessary evidence is missing, assess available logs or read-only access. An access proposal preserves the service's required authorizations.

## Documents and review

Use existing documents: `AGENTS.md` for operational pointers, code rules in the project-chosen document, documentation as a source, and skills for callable procedures. Create a document only when responsibility justifies it.

Implementers and reviewers follow applicable rules. Review receives the sources needed to verify the change: requirements, instructions, relevant context and differences. A new rule must prevent the observed problem without adding obligations outside the brief. Read [process execution](../geppetto-adopt/references/processes.md) before tools.
