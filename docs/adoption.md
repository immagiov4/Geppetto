# Geppetto self-adoption

Source skills in `skills/` are authoritative. Generated copies under `.agents/skills` and `.claude/skills` are ignored. `.geppetto/bin` supplies command entrypoints importing canonical tracked source. The local manifest records ownership; the user machine registry records shared hooks, maintenance jobs, key location and memory repository.

The project writes documentation in English, uses behavior tests and the bundled review procedure, and runs its GitHub Actions matrix. [Development](development.md) owns the check and refresh commands.

[Installation](../skills/geppetto-adopt/references/installation.md#memory) offers local Git memory, private GitHub memory, native memory or no memory in its single question and reuses recorded choices. Claude's native directory can point into the project bucket, with key-level ownership for uninstall. [Maintenance registrations](../skills/geppetto-learn/references/jobs.md) are shared through the memory repository's `jobs.md`.

## Observability

Run `audit.mjs --project . --verify` after refreshing. Synthetic tests cover every memory choice, reuse, native directory merge/uninstall, two clones sharing job registrations, plugin reuse, adoption commits, hooks, paid caps and the learner lock. GitHub creation and OS registration use injected commands and schedulers; the hidden Windows launcher runs a synthetic child. Compare project inventories and inspect machine job IDs, cadence, next run and disable controls; OS job output lives in `~/.geppetto/<job>.log`. Hook outcomes remain in ignored local files.
