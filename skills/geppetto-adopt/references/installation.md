# Installation

Node 22+ and Git are required. Resolve `<adopt>` from the installed plugin or source checkout; keep using that path throughout adoption.

```sh
node <adopt>/scripts/install.mjs --target <target> --project <project> --begin
node <adopt>/scripts/install.mjs --target <target> --project <project> --plugin-hooks --dry-run
node <adopt>/scripts/install.mjs --target <target> --project <project> --plugin-hooks
```

Targets are `claude`, `codex` and `agents`. With a plugin installed for that target, always pass `--plugin-hooks`: the project receives only CI gate modules, configuration, ownership state and the generated router/import/CI. Plugin mode persists on updates and reconciles owned duplicate skill copies. Only targets without the plugin receive project skill copies and shared user hooks. `--user` selects user-level installation instead of project adoption. Existing user memory defaults stay authoritative; project configuration holds bucket links.

The hash manifest protects edits and foreign files; reruns reconcile ownership and `--uninstall` removes owned files. External CI gates are standalone; source-repository entrypoints import canonical scripts. Dry runs are read-only. Exit codes: 0 success, 1 conflict/check/blocker, 2 invalid arguments. If machine registration is permission-blocked, put the installer's single retry command in the recap for execution outside the sandbox.

## Project instructions and CI

`--begin` creates `geppetto-install` for both harnesses. Set `docs.root` to the folder that holds feature pages only, so indexes and governance pages are not checked as features. Preserve existing project rules while adapting the [router](../assets/templates/AGENTS.md), [CLAUDE import](../assets/templates/CLAUDE.md) and [CI](../assets/templates/ci/README.md). For large instruction migrations, use `migrate-agents.mjs inventory` and `verify` to check retention. Keep inventories, instruction diffs, requirements maps and installation evidence inline in the recap or outside the project, in harness temporary storage or `~/.geppetto/`.

Record generated files with `--record-generated <project-relative-path>`; write only Geppetto-owned project files. Record existing project checks as `hostChecks.changed`. Follow [jobs](../../geppetto-learn/references/jobs.md) before running installation: attach available native scheduler jobs and hand their registrations to `--scheduler-jobs <external-json>`. Otherwise the installer attaches OS jobs through the subscription CLI, hidden on Windows.

## Verify

Run `<adopt>/scripts/audit.mjs --project <project> --verify`, a synthetic prompt hook and memory listing. For Codex, use `<adopt>/scripts/codex-hook-trust.mjs --project <project> --plugin <actual-plugin-id> --approve` (or `--source <hooks-file>` for shared hooks). Then run the installer with `--target <target> --project <project> --commit`: it commits only owned installation paths on `geppetto-install`, preserving unrelated staged work. Include the commit and recap table in the response.

[Process execution](processes.md) governs child processes. Runtime and provider limitations are listed once in the README's Limits section.
