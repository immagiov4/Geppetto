# Process provenance

The procedure derives from studying Qwen Code at revision `b906f937ec041ca9124617bf86726de064bea967`.

- [Review documentation](https://github.com/QwenLM/qwen-code/blob/b906f937ec041ca9124617bf86726de064bea967/docs/users/features/code-review.md): describes scope, levels and call cost.
- [Searcher and verifier instructions](https://github.com/QwenLM/qwen-code/blob/b906f937ec041ca9124617bf86726de064bea967/packages/cli/src/commands/review/lib/agent-briefs.ts): require concrete scenarios, cross-file paths, checks of removed behaviour and counterevidence.
- [Actual coordination](https://github.com/QwenLM/qwen-code/blob/b906f937ec041ca9124617bf86726de064bea967/packages/core/src/skills/bundled/review/SKILL.md): keeps a cumulative list, verifies reports and searches for gaps with reading receipts.

The local adaptation uses two independent searches and a separate verification pass to measure a bounded cost with Sol. Qwen distributes more perspectives and repeats gap discovery to its stopping criterion. This procedure covers the assigned perspectives in one collection; the report retains examined aspects and those requiring other evidence. Check model-declared coverage against tool events.

Qwen's thresholds reflect its coordinator. Extending roles or rounds here requires a concrete risk or gap, with cost and scope agreed.

Official Codex documentation describes [model selection](https://learn.chatgpt.com/docs/models) and [noninteractive execution](https://learn.chatgpt.com/docs/non-interactive-mode). Verify the installed CLI's behaviour and options through `--help` and a successful request. The session record allows checking effective model, reasoning and protection without reading credentials.
