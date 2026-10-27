# Installation

Node 22+ and Git are required. Source skills live in `skills/`; installations are generated copies. Use the source checkout's installer or an installed copy with recorded package provenance.

```sh
node <adopt>/scripts/install.mjs --target <claude|codex|agents> --project <project> --dry-run
node <adopt>/scripts/install.mjs --target <claude|codex|agents> --project <project>
```

Use `--user` in place of `--project` for user-level skills. `--plugin-hooks` reuses plugin-level hooks; otherwise installation merges one shared hook set into the user's harness settings. Project settings remain project-owned. The installer reads `~/.geppetto/machine.json`, reuses the key location and memory repository, and records maintenance jobs for attachment through [jobs](../../geppetto-learn/references/jobs.md). Existing user memory configuration remains authoritative; projects store only their bucket selection.

The hash manifest `.geppetto/install.json` protects existing edits and foreign files. Reruns reconcile owned files; `--uninstall` removes owned files. External projects receive standalone scripts in `.geppetto/bin`. The Geppetto source repository uses small command entrypoints importing its tracked canonical source. Exit codes are 0 success, 1 conflict/check failure, 2 invalid arguments. Dry runs inspect project file changes without writing.

## Project instructions and CI

Work on the local installation branch. Read the existing instructions, preserve their project rules at their current owners and adapt the [router](../assets/templates/AGENTS.md). For a large migration, `migrate-agents.mjs inventory --source <original>` and `verify --inventory <json> --map <json> --project <project>` check paragraph retention. Apply the migration and link its diff in the final recap.

Adapt [CLAUDE](../assets/templates/CLAUDE.md), [PR](../assets/templates/pr-ticket.md), [feature](../assets/templates/feature-doc.md) and [CI](../assets/templates/ci/README.md) templates. Record generated files with `--record-generated <project-relative-path>` so reconciliation protects them. Inspect `host-lint.mjs --project <project> --json`, register generated paths in the host's ignore configuration and record its existing check command as `hostChecks.changed`.

## Verify

Run `audit.mjs --project <project> --verify`. Exercise a prompt hook and a memory listing on synthetic inputs. For Codex, inspect and persist the accepted installation's hook hashes with `codex-hook-trust.mjs --project <project> --plugin <actual-plugin-id> --approve`; use `--source <absolute-hooks-file>` for the shared file instead. The helper preserves disabled, managed and unrelated hooks and verifies saved hashes.

[Process execution](processes.md) governs child processes. Runtime and provider limitations are listed once in the README's Limits section.
