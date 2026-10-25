# Semantic hooks

Offer each hook separately in two lines: what it does and why it may help. Keep a recorded decline across adoption reruns.

- **Bridge/System 1:** Suggests relevant skills for each request. Measure whether it reduces missed procedures without excessive noise or context.
- **Memory classifier (`hooks.memoryClassifier`):** With an OpenRouter key, a per-message two-stage classifier suggests relevant pages as “You may want to check out: buckets/<b>/<page>.md — reason”. Measure retrieval value, privacy boundaries, noise and added context; the agent opens and judges pages itself.
- **Requirements screen:** Ranks candidate source files before requirements discovery. Measure additional missed-path discovery; source reading and caller tracing still decide relevance.

All semantic hooks default to declined. The memory classifier starts with `hooks.memoryClassifier.enabled: false`; the deterministic session-start bucket listing and linked-index injection work without a key or classifier. After interest, request the OpenRouter key through the harness's private secret mechanism; use another provider only where the chosen hook supports it. Keep the key out of chat, configuration committed to Git, signals and reports. If private secret entry is unavailable, report that prerequisite and keep the hook disabled.

Read `$geppetto-measure-it`; route paid calls through `$geppetto-authorize`. Build a project-specific comparison on authorized real cases with and without the hook, including omissions, noise, latency, reported cost and added tokens. Record cases, versions and limits so the result can be repeated. Show results and ask whether to keep it; benchmark authorization alone does not authorize permanent activation. Store the decision and benchmark reference in `.geppetto/config.json`.

For the memory classifier, compare direct injected-index retrieval with classifier-assisted retrieval on the same authorized questions and bucket indexes, including Global preferences and project links. Record suggested pages actually opened and useful supported facts found; suggestions remain hints. Obtain consent for sending the message/index context to OpenRouter separately from local memory reads. Retain the disabled default until results and an explicit keep decision justify activation.

Passive transcript reading and a reducer/state-machine process remain experiments requiring replay evidence. Calibrate any scoring threshold instead of shipping the diagram's `>0.75` example as policy. Transcript access needs a separate scoped grant. Introduce a reducer only after an ordinary skill fails to enforce a specific well-defined process.
