# Geppetto self-adoption

Source skills in `skills/` are authoritative. Generated copies under `.agents/skills` and `.claude/skills` are ignored. `.geppetto/bin` supplies command entrypoints importing canonical tracked source. The local manifest records ownership; the user machine registry records shared hooks, maintenance jobs, key location and memory repository.

The project writes documentation in English, uses behavior tests and the bundled review procedure, and runs its GitHub Actions matrix. [Development](development.md) owns the check and refresh commands.

## Observability

Run `audit.mjs --project . --verify` after refreshing. Synthetic tests cover two projects sharing one machine, hook behavior, paid API caps and the learner lock. Hook events retain outcomes and diagnostic metadata in ignored local files.
