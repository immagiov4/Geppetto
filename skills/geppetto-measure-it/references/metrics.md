# Metrics

Choose the smallest set that can decide the current hypothesis. These defaults are editable; name the improved metric and the one at risk. Define units, observation method, cases, baseline revision and decision rationale. Seek approval for a new decision metric.

- **Cognitive complexity:** identify hard-to-follow control flow at the owning functions; compare maintainability with any abstraction or file-navigation cost. A numeric limit comes from the project, not this list.
- **Test usefulness:** behaviours and design choices protected, observed regressions caught, false confidence and meaningful red/green evidence. Coverage percentage alone is not proof of usefulness.
- **Task time:** measure elapsed time and break down tests, tool calls, machine/CPU, hooks and reasoning. Show overlapping intervals; never sum parallel durations as elapsed time. Identify the limiting component before optimising.
- **Cost and tokens:** actual model × reasoning level, provider-reported cost, consumed tokens and context-window contributions from skills, instructions, memories and tool results. Unknown charges stay unknown until reconciled.
- **Reviewer quality:** supported real bugs found, false positives, missed defects in the evaluated cases, correction rounds, time, cost and harmful unnecessary fixes. Agreement among reviewers is a clue, not ground truth. Validate findings against paths and contracts.
- **Correction rounds and satisfaction:** observed recurring corrections and user evidence. Separate a user's explicit preference from an inferred proxy for satisfaction; count independent episodes separately from attempts within one episode.

Retain each comparison's inputs, versions, results and important limitations in the existing owner or external evidence artifact. Review metric value during periodic learning: keep, merge, revise or retire with a reason. Avoid creating a permanent dashboard for a single comparison unless it serves an agreed ongoing need.
