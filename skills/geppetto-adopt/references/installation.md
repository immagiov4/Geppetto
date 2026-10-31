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

The person installing does not know what Geppetto does. Ask once, in their language, with the recommended settings filled in from the audit. Leave out lines already configured on this machine; fill `<runtime>` with the CLI and model that will actually run, preserving the current model and service tier.

Explain the small baseline: keep evidence of what happened, design technical observability before building, and place a verified improvement at its existing owner. Show the actual workflow defaults that will apply—decision checks, review trigger, required sections and companion choices—with the purpose of each. Compare them with the maintainer's selected skills and conventions. When they prescribe another method, agree how to preserve the baseline through that method and record the configuration or routing change; reuse it afterward. A bundled procedure is a fallback when no alternative has been selected. Repository-specific PR formats, documentation layouts and review thresholds are choices, not universal engineering rules.

> Install Geppetto here with these settings? Reply yes, or change any line.
>
> 1. **Memory**: where lessons are saved. A local Git folder (recommended), a private GitHub repo to share them across computers, Claude's or Codex's own memory, or none.
> 2. **Checks while working**: yes. Before editing, the agent writes down what it decided; before finishing a large change, `<runtime>` reviews it and receives that change.
> 3. **Finding the code a change touches**: yes. Your request and the project's committed code go to OpenRouter, private projects included.
> 4. **Learning from your corrections**: yes. `<runtime>` reads short excerpts of the conversation, with secrets removed, and improves the skills.
> 5. **Weekly upkeep**: yes. `<runtime>` tidies skills and memory once a week.
> 6. **GitHub check**: yes. A GitHub Actions workflow checks each pull request.

When the OpenRouter key is missing, add to line 3 an offer to enter it through private secret entry. The first specification settles technical observability and any needed documentation structure before implementation, through geppetto-spec. At design time, strongly recommend Architect and Codebase Design and offer Engineering Workflow as the execution router; reuse installed copies. Extra pstack principles are optional after checking overlap. Follow the [companion catalog](integrations.md) for sources and installation.

Record the answers before installing: line 1 through `--memory`; line 2 through `hooks.reviewGate.enabled`, which turns off both the decision record and the review; line 3 through `python <screen>/scripts/screen.py --repo <project> --share-source yes|no`; line 4 through `hooks.learnNudge.enabled` and `hooks.signalLearning.enabled`, with a changed runtime in `hooks.signalLearning.model` and `.reasoningEffort`; line 5 through `maintenance.enabled`; line 6 through `ci.enabled`. Register `.geppetto/config.json` with `--record-generated` when updating an owned configuration. The recap repeats each line with its actual value and how to change it; report a missing prerequisite (Node 22+, Git, Python 3.10+, a signed-in CLI) beside the line it blocks. Never show the key's value.

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
