# Installation

Node 22+ and Git are required. Resolve `<adopt>` from the installed plugin or source checkout; keep using that path throughout adoption.

```sh
node <adopt>/scripts/install.mjs --target <target> --project <project> --begin
node <adopt>/scripts/install.mjs --target <target> --project <project> --plugin-hooks --dry-run
node <adopt>/scripts/install.mjs --target <target> --project <project> --plugin-hooks
```

Targets are `claude`, `codex` and `agents`. With a plugin installed for that target, always pass `--plugin-hooks`: the project holds configuration, the router/import and a workflow that runs a pinned Geppetto package, plus ignored runtime ownership state. Plugin mode persists on updates and reconciles owned duplicate skill copies. Only targets without the plugin receive project skill copies and shared user hooks. `--user` selects user-level installation instead of project adoption. Existing user memory defaults stay authoritative; project configuration holds bucket links.

An update reconciles every installed target before retiring shared scripts. The local hash manifest is ignored and untracked, protects edits and foreign files; reruns reconcile ownership and `--uninstall` removes owned files. CI runs the package gate; local commands resolve `<adopt>/scripts/` from the installed plugin or skill. Dry runs are read-only. Exit codes: 0 success, 1 conflict/check/blocker, 2 invalid arguments. If machine registration is permission-blocked, put the installer's single retry command in the recap for execution outside the sandbox.

## Capability question

Ask this single question, adapting existing values and available companions from the audit:

Install Geppetto here with these choices (recommended answers shown)?

- Memory: reuse the configured location; otherwise a local Git folder (recommended), a private GitHub repo for sync, tool-native memory, or none. GitHub sync sends saved memories to GitHub.
- Hooks: yes (recommended); local checks guide work and require review before substantial changes finish.
- Source screen: yes (recommended); send committed source files and the request to OpenRouter to find affected code, including private projects. The key can select providers that keep no data.
- Background learner: yes (recommended); the selected Codex or Claude CLI sends filtered transcript slices to its model provider to propose improvements. Choose the CLI/model; recommend the current authorized selection.
- Maintenance jobs: yes (recommended); weekly skill and memory upkeep uses that CLI/provider with skill and memory context, excluding private buckets.
- Review runtime: the current authorized CLI/model (recommended); it sends the change and relevant code to its provider for independent review.
- Project conventions: reuse existing documentation, error visibility and checks (recommended); agree missing conventions before recording them. These checks run locally and in CI.
- CI workflow: yes (recommended); GitHub Actions checks pushed project files using a pinned Geppetto version.
- Integrations: reuse installed companions (recommended); name each proposed addition and its data destination before choosing to install it.

Only when missing, offer the OpenRouter key once through private secret entry. Node 22+, Git, Python 3.10+ for screening, and signed-in CLIs are prerequisites to report in the recap.

Record the answers before enabling capabilities: memory through `--memory`; hooks through `hooks.reviewGate.enabled`, `hooks.learnNudge.enabled` and `hooks.signalLearning.enabled`; learner CLI/model/effort through `hooks.signalLearning.host`, `.model`, `.reasoningEffort`; source permission through `python <screen>/scripts/screen.py --repo <project> --share-source yes|no`; jobs through `maintenance.enabled`; project conventions through `foundations`, `docs.root` and `hostChecks.changed`; review runtime through `review.engine` and the selected runtime's settings; CI through `ci.enabled`; integration additions only after the answer. Preserve the current authorized model and service tier. A declined learner sets `hooks.signalLearning.enabled: false`; declined hooks disable all three hook policies. Configure before installation and register `.geppetto/config.json` with `--record-generated` when updating an owned configuration.

The recap lists every question item with its actual value and the control above, including memory location, source permission, key availability (never its value), learner CLI/model/effort, job identities/cadence/next run/disable controls, review runtime, CI path and integration selections. Report prerequisite blockers beside their affected capability. Hooks themselves run local checks; learning and review use the chosen provider.

## Memory

Reuse memory from the machine registry or `~/.geppetto/config.json`, including a recorded native-only or no-memory choice. Otherwise include the four choices below in the single capability question.

| Choice | What the user gets | Installer argument |
|---|---|---|
| Local Git folder (recommended) | `~/geppetto-memory`, shared by Claude and Codex, with history of every change; link to GitHub later. | `--memory local` |
| Private GitHub repo | The same, plus sync across machines; needs GitHub access through `gh`. | `--memory github` |
| Only Claude/Codex's own memory | Separate per tool and per machine. | `--memory native` |
| No memory | A recorded choice; bucket hooks stay silent. | `--memory none` |

The first two choices seed root `index.md`, global `preferences` and a project bucket, then record `memory.repo` and `memory.localPath`. Private creation uses `gh repo create --private`. Claude's project `.claude/settings.local.json` receives `autoMemoryDirectory: <localPath>/buckets/<project-bucket>/claude/`, merging other keys. The machine registry records that key and its prior value; last project-target uninstall restores it while preserving user edits. Codex retains its native memory location. The recap includes the choice, location and `--memory` control. Read [jobs](../../geppetto-learn/references/jobs.md) before proposing scheduler attachment.

## Semantic requirements screening

The optional OpenRouter key enables semantic screening in `$requirements-blast-radius`. Supply `OPENROUTER_API_KEY` through the launching environment or its private secret mechanism. The screen reads that variable directly and reports provider usage; [screen setup](../../requirements-blast-radius/references/screen.md) owns its source boundary, modes and checks.

## Project instructions and CI

`--begin` creates `geppetto-install` for both harnesses, initializing Git when the project has no repository. `--commit` creates the first revision when needed and includes owned installation files, their recorded deletions and the removal of a tracked local registry; existing application files and unrelated staged changes stay outside that commit. Set `docs.root` to the folder that holds feature pages only, so indexes and governance pages are not checked as features. The installer renders and owns the [CI workflow](../assets/templates/ci/README.md), using the source checkout HEAD or an explicit reviewed `--gate-sha <40-character-SHA>` when the package has no Git metadata. Reruns refresh that pin while protecting owner edits. Preserve existing project rules while adapting the [router](../assets/templates/AGENTS.md), [CLAUDE import](../assets/templates/CLAUDE.md). For large instruction migrations, use `migrate-agents.mjs inventory` and `verify` to check retention. Keep inventories, instruction diffs, requirements maps and installation evidence inline in the recap or outside the project, in harness temporary storage or `~/.geppetto/`.

For standalone hook fragments, substitute `${CLAUDE_PLUGIN_ROOT}` with the absolute package root; the shared installer hooks already resolve that path. Record generated files with `--record-generated <project-relative-path>`; write only Geppetto-owned project files. Record existing project checks as `hostChecks.changed`. Follow [jobs](../../geppetto-learn/references/jobs.md) before running installation: attach available native scheduler jobs and hand their registrations to `--scheduler-jobs <external-json>`. Otherwise the installer attaches OS jobs through the subscription CLI, hidden on Windows.

When the task specifies a model for unattended work, record it as `hooks.signalLearning.model` before enabling the learning child; for Codex, preserve the requested effort as `hooks.signalLearning.reasoningEffort`. Verify that the actual child uses that selection.

## Verify

Run `<adopt>/scripts/audit.mjs --project <project> --verify`, a synthetic prompt hook and memory listing. Complete [hook activation](../assets/templates/hooks/README.md#activation) for the target harness and project. Then run the installer with `--target <target> --project <project> --commit`: it commits only owned installation paths on `geppetto-install`, preserving unrelated staged work. Rerun the audit after committing: learning needs an initial Git revision and must report ready before adoption is complete. Include the commit and recap table in the response.

[Process execution](processes.md) governs child processes. Runtime and provider limitations are listed once in the README's Limits section.
