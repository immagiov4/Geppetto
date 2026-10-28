---
name: geppetto-measure-it
description: "Measure before claiming or adding. Use for an optimisation, a slower/costlier/better claim, or a new rule, hook or check."
---

# Measure

Every addition names the metric it improves and the metric it may worsen. A proposed metric needs a reason and approval before it becomes a decision rule. Read [metrics](references/metrics.md) when selecting or reviewing measures; all defaults are editable.

Establish the baseline before the change, run the treatment on comparable cases and inspect regressions in other metrics. Build the measurement tool appropriate to the task; this principle prescribes evidence, not a benchmark framework. Keep versions, inputs, configuration, actual work and observation method identifiable. Verify that the observed result measures the intended work rather than a cache, omitted path, load difference or failed operation.

Separate wall time from resource time. Parallel durations overlap and cannot be added as elapsed time. Cost and tokens need the actual model, reasoning level and consumed context; a single run supports a claim about that run, with its uncertainty.

Look for changes that improve both competing metrics, such as frequent cheap complexity feedback that prevents a late large refactor. Retain an improvement only when the comparison supports its benefit and its regressions are acceptable. Periodically review whether each metric remains useful, needs consolidation or should change. Complete when baseline, treatment, tradeoffs and keep/revert decision are inspectable on the actual artifact.
