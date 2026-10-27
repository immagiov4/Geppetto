# Trusted gate bootstrap

The first adoption pull request cannot trust the gate scripts in its own head, because that head is the change under review. Before that PR, the repository owner sets two Actions variables: `GEPPETTO_BOOTSTRAP_REPOSITORY` (`owner/repository`) and `GEPPETTO_BOOTSTRAP_SHA` (the full 40-character commit of a Geppetto package the owner has already reviewed). The pinned repository must be readable by checkout. That package must include `skills/geppetto-adopt/scripts/pr-event.mjs` and its imports. An absent pin fails with an actionable diagnostic.

The workflow runs on `pull_request_target`, checks out the PR's trusted base and runs the gate installed there. When this repository is Geppetto itself, it runs the package gate. If neither exists, it fetches the owner's pinned package into a separate directory. Permissions stay read-only, and checkout credentials are removed afterwards. The PR body comes from the event payload. Changed Markdown files under the configured docs root are listed through the GitHub API and downloaded at the immutable PR head into temporary storage for `gate-sections --docs`. Removed files are skipped. The workflow executes only trusted base or pinned package code and uses base configuration. The first adoption uses the package's default docs root and required sections. Project-specific requirements take effect once the adoption is in the trusted base.

Keep the pins as repository variables under owner control. When bootstrap policy changes, select and review a new immutable commit. Run the local gate-source decision tests before publishing, and treat remote CI as a separate acceptance check.

## Observability

The section gate reports the document path, line and missing or empty heading; successful checks report the number of documents. API errors and PR file lists exceeding GitHub's 3,000-file response limit fail the check. Temporary head content is removed after validation. Behaviour tests cover bootstrap selection, the workflow trust boundary, changed-document filtering and configured section failures; remote Actions execution remains a separate integration check.
