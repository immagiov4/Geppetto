# Pinned package gate

Project CI checks out the trusted PR base into `project/` and `immagiov4/Geppetto` at an immutable commit into the separate `geppetto/` directory. The installer writes the repository and full SHA directly into the workflow. Source installations use their checkout HEAD; packages without Git metadata require `--gate-sha <reviewed-SHA>`. Rerunning the installer refreshes the pin and reconciles owned files. Owner edits require reconciliation before an update or uninstall.

The workflow runs on `pull_request_target` with read-only permissions and pinned actions. It executes the package's `pr-event.mjs` with the trusted project base as its working directory, so configuration comes from that base. The PR body comes from the event payload. Changed Markdown under the configured docs root is downloaded at the immutable head into temporary storage and checked as data. Removed files are skipped. When the PR edits configuration, required document sections combine the base and incoming contracts. The first adoption uses default requirements until project configuration reaches the trusted base.

Local agent commands resolve scripts from the installed plugin or skill. A plugin project contains `.geppetto/config.json`, this workflow, its router and CLAUDE import. Ownership, authorizations and hook state live in ignored `.geppetto/` runtime files.

## Observability

Section checks report the document path, line and missing or empty heading; successful checks report the number of documents. API errors and PR file lists exceeding GitHub's 3,000-file response limit fail the check. Temporary head content is removed after validation. Behaviour tests execute generated workflow commands against synthetic base/package directories, verify SHA refresh and ownership protection, and cover changed-document contracts. GitHub Actions execution remains an integration check on the published revision.
