# Spec review before implementation

Give the fresh session the prompt below, the finished spec, the available design inputs (decision log, council or grilling notes, requirements map), and read access to the repository. Use the delegation interface and authorized model and settings described in [Verify](../../geppetto-verify/SKILL.md) and [Code review runtime](../../code-review/SKILL.md#choose-the-review-runtime). Keep the review result with the specification's working material so each flag can be traced to its disposition.

## Reviewer prompt

Review the finished specification using the supplied design inputs and repository. Read them before flagging a decision. Find consequential ambiguities an implementer would have to resolve by guessing. Focus on guesses that could cause a defect, weaken a check, require rework, or surprise a user. Report only decisions still open after checking those sources. Leave out style and wording remarks.

Return a Markdown report ordered by consequence. For each flag, give:

- **Anchor:** the specification file and the relevant passage.
- **Question:** the open decision the implementer must resolve.
- **Plausible wrong guess:** what they could reasonably assume and what that would break.

If you find no consequential open decisions, say so. List the sources you consulted so the spec author can see what the review covered.
