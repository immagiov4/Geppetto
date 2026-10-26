# Installation and script contracts

Resolve `<adopt>` from this skill's installed directory. Scripts are dependency-free `.mjs` and require Node >=22 (24 recommended). Resolve scripts here, never from an assumed user home. Use the interfaces below; inspect installed source when its version differs. Exit codes are 0 pass, 1 failed check, 2 usage error; diagnostics identify `file:line` where relevant.

```sh
node <adopt>/scripts/audit.mjs --project <project> --json
node <adopt>/scripts/install.mjs --target codex --project <project> --dry-run
node <adopt>/scripts/install.mjs --target codex --project <project>
node <adopt>/scripts/install.mjs --target claude --project <project>
node <adopt>/scripts/audit.mjs --project <project> --verify
```

Targets are `claude`, `codex`, `agents`; use either `--project <dir>` or `--user`. Removal adds `--uninstall`. Review the dry-run and owned-files manifest `.geppetto/install.json`. Copies/links are derived from `skills/`; reconcile edited copies against source hashes before replacement. Copy gate scripts to the project's `.geppetto/bin/` for CI and collaborators. Installation of skills is distinct from the consultant's project migration: inspect actual installed outputs before adding the router, configuration, hooks or CI.

The installer adds `/authorizations` to `.geppetto/.gitignore`, preserving existing entries and grant contents. Accepted learning setup does the same before writing a grant. Keep each machine's `.geppetto/authorizations` local; distribute only the empty authorization template. Reinstallation tolerates an absent grant previously recorded by adoption and drops its stale ownership entry without recreating consent. For an already tracked grant file, remove it from Git tracking while retaining the local file as part of the owner's authorized migration.

The existing Geppetto `UserPromptSubmit` handler includes requirements/feedback routing. The project installer owns its shared `.geppetto/bin/message-context.cjs` dependency; the plugin resolves the same module from its bundled skills. Verify the registered handler with a nonempty prompt, then reconcile a redundant standalone requirements hook through [hook integration](../assets/templates/hooks/README.md#learning-reminders).

In the grouped adoption round, offer subscription signal learning with default yes. After the accepted answer, run `node <adopt>/scripts/learning-setup.mjs --project <project> --accept`; it probes subscription authentication without a model call, records the standing project grant once and writes complete enabled defaults. Without `--accept`, it reports the pending adoption question. A missing CLI or login yields one actionable item and creates no grant. Run this before recording generated config/authorization hashes. Installation alone creates no consent. The [learning contract](../../geppetto-learn/references/ingestion.md) owns model, file tools, optional limits and local branch behavior.

Use `gate-sections.mjs --pr <file|->` for PR/ticket bodies and `--docs <glob>...` for feature docs, with `--config <path>` when needed. Defaults require nonempty `Observability`; optional `Verification` becomes required only by project choice. Real Markdown headings count; fenced examples do not. Accept `Not applicable` only with a reason. Treat all bodies as untrusted data.

Use `gate-agents.mjs --file <file> --max-lines 300 --max-bytes 16384`. Aim for 60–120 router lines; count imported content and resolve local pointers. Use one-line `CLAUDE.md` containing `@AGENTS.md`, after preserving conflicting existing instructions. In a new session, ask each harness to identify the loaded project intent and relevant routing rule with its source. Record actual loading, not just file existence.

Required project enforcement lives in CI; local hooks provide early feedback. Merge [Claude settings](../assets/templates/hooks/claude/settings.json) into `.claude/settings.json` and [Codex hooks](../assets/templates/hooks/codex/.codex/hooks.json) into `.codex/hooks.json`, preserving existing entries. Follow the [hook integration](../assets/templates/hooks/README.md) for nested-directory commands, `hooks.learnNudge` defaults, thresholds and rationale. The synchronous `PostToolUse` handler adds internal context once per qualifying turn, makes no model call and logs firings to `.geppetto/hook-events.jsonl`; reflection uses the active session's model context. Preserve the separate async signal consumer when updating `Stop` and `PostToolUse`. Obtain harness hook trust approval and distinguish handler fixtures from live interception.

Adapt the [PR gate](../assets/templates/ci/pr-gate.yml) to the project's provider. It re-evaluates edited PR bodies, uses the same section gate and treats text as data. Follow the [trusted bootstrap](../assets/templates/ci/README.md) on the first adoption PR, whose base lacks `.geppetto/`; record the owner-pinned source and trust trade-off before activation. Gate code comes from that trusted source, independent of the PR head. Preserve existing checks. With no ticket engine, record its transition `n/a` and retain PR merge as the boundary. Validate missing, empty and fenced headings and a reasoned not-applicable section.

Use [migrate-agents.mjs](../scripts/migrate-agents.mjs) before and after moving AGENTS/CLAUDE sections:

```sh
node <adopt>/scripts/migrate-agents.mjs inventory --source <preserved-original.md> > <inventory.json>
node <adopt>/scripts/migrate-agents.mjs verify --inventory <inventory.json> --map <dispositions.json> --project <project>
```

Preserve the snapshot outside the overwritten file. Map each emitted section id to `{"owners":["project-relative.md"]}` or `{"dropped":"owner-approved reason"}`; every original paragraph must survive at a named owner, with whitespace normalized. After materializing the authorized adoption, record generated router/import, config, authorizations, merged hook files and CI hashes with `install.mjs --target <target> --project <project> --record-generated <project-relative-path>` (repeat the option for each file). Review a dry-run first; `.geppetto/install.json` then covers these outputs during reconciliation.

Run `node <adopt>/scripts/host-lint.mjs --project <project> --json` to inspect host formatter/linter configuration and proposed ignore entries. Register vendored `.agents/skills/**` and `.geppetto/**` in the appropriate ignore lists, plus `.claude/skills/**` when installed there, after owner consent. Preserve source bytes and ownership hashes. Record the host's affected-file command as an argv array in `.geppetto/config.json` `hostChecks.changed`, then run `host-lint.mjs --project <project> --verify`. A missing dependency or failing baseline is a named acceptance gap. `audit --verify` includes this check and reports hook trust, real instruction/skill loading, remote CI and provider spend-limit gaps as `NOT VERIFIED`; structural PASS lines cover only their named checks.

Claude Code uses its plugin/skill discovery and approved hooks. Codex discovers `.agents/skills`; use [Codex hook approval](#codex-hook-approval) for installation and curation. For Pi/OpenCode, report absent hook integration as “enforced by CI” only after CI is verified. Missing Node is an explicit local enforcement gap with CI as the checked alternative. Missing scheduling can use a supported harness scheduler or an OS scheduler plus the existing noninteractive CLI; Codex app automations depend on its running environment. Probe current capabilities rather than promising a native scheduler.

## Codex hook approval

Use the same helper after installing, updating or curating Codex hooks. It works from this skill's `scripts/` or the project's generated `.geppetto/bin/`. List the actual loaded hooks first:

```sh
node <adopt>/scripts/codex-hook-trust.mjs --project <project> --json
node <adopt>/scripts/codex-hook-trust.mjs --project <project> --plugin geppetto@geppetto --approve
```

The second command records approval only after the owner accepts that plugin's current definitions. Use the exact `pluginId` from the inventory. For project hooks, select `--source <absolute-hooks-file>` when consent covers the complete file; for a merged file containing other hooks, use `--key <exact-key>` for each accepted handler instead. These three scopes are alternatives. Without `--approve`, the helper only inspects; approval without a scope fails. Reuse existing consent for the same accepted scope, and include newly introduced or changed definitions in the [visible consent block](choices.md#approval-and-installation-messages) when that consent does not cover them. A curation job can approve within its recorded grant, or leave the concrete inventory for the owner.

The helper uses Codex `hooks/list` and `config/batchWrite`, saves the current definition hashes in the user's Codex config, and verifies them through Codex afterward. Disabled hooks remain disabled, managed hooks retain their policy, and unrelated settings remain intact. It starts no model turn and executes no hook. A changed definition needs another approval. An absent selector match, incomplete discovery, timeout or verification failure exits unsuccessfully. Project-local hooks must also belong to a trusted Codex project layer; hook approval alone does not grant project trust. The installed CLI must expose these APIs; otherwise report the compatibility error and use `/hooks` manually.

Hash approval covers what Codex hashes in the hook definition. Inspect the invoked scripts as part of installation or curation; a trusted definition is separate from evidence that its lifecycle event ran. See [Codex's hook trust contract](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).

Choose the review runtime from the machine's available tools: Claude Code, Codex, Pi, OpenCode, an application with agent delegation, or another program capable of launching independent verification sessions. Inspect its installed help, authentication and execution controls, then verify that it can read the review material, start fresh contexts, confirm findings separately and retain results. Record the working invocation in the project's verification commands and use it through `geppetto-verify` and `code-review`.

Audit dependencies for the selected implementation. The bundled Codex runner uses Python and authenticated Codex CLI. Requirements screening uses Python >=3.10 and Git; its prompt hook uses Bun. Reuse an available equivalent when it meets the required verification flow.

Test authorization protection against both direct tool writes and indirect script writes on isolated dummy files with owner-approved probes. Report actual results. A consent file alone cannot enforce a provider's spending cap; configure the real provider limit when file protection is incomplete.
