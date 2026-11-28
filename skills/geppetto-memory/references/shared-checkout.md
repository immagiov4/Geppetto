# Shared memory checkout

Several writers use one memory checkout at once: other agent sessions, Claude native memory in `buckets/<bucket>/claude/` and the weekly maintenance job. Git gives them one index and one working tree, so each writer touches only its own paths.

**Ownership.** Paths you edited in this session are yours, including files your harness's native memory wrote. Run `git status --porcelain` before editing: any other uncommitted path belongs to another writer. Leave it unedited, unstaged and uncommitted. When a page you need already carries such a change, report the path and keep the candidate pending until the user or its writer resolves it. The [scheduled maintenance job](../../geppetto-learn/references/jobs.md#observability) skips uncommitted paths and uses committed native memory only as comparison evidence.

**Update before editing.** When the repository has a configured remote, run `git pull --ff-only <remote> <branch>` using the resolved destination remote and current branch, matching the repository's publication target rather than an arbitrary upstream. It leaves other writers' files alone and refuses rather than overwrite one. When it refuses, report the cause instead of editing a stale page. Local-only repositories with no remote skip the pull.

**Commit.** Pass `--literal-pathspecs` to Git commands that take file paths so filenames containing glob characters like `[1]` never match another writer's file. Check `git diff --cached --name-only` first:

- When the index is empty, stage your paths with `git --literal-pathspecs add -- <paths>` (never `-A` or `.`), confirm that `git --literal-pathspecs diff --cached` holds exactly the intended edits with no entry duplicated by a repeated save, and commit that verified index snapshot with `git commit -m <message>`.
- When another writer already has staged paths in the index, leave their staged paths untouched. For a non-native path you own, verify `git --literal-pathspecs diff HEAD -- <paths>` and commit with `git --literal-pathspecs commit --only -m <message> -- <paths>`. Do not commit a native-memory path with `--only` while the index is busy, because `--only` reads the working tree rather than a verified index snapshot; report and leave it pending instead.

**Recover a rejected push.** Plain `git pull --rebase` refuses while other writers have uncommitted changes, and the post-commit hook's failure hint predates this rule. Check `git diff --cached --name-only` first: if another writer has staged entries in the index, do not run `--autostash` (it restores working-tree content without preserving staged index selections); keep your commit local and report both the pending commit and the other writer's staged paths. When the index is clean, run `git pull --rebase --autostash <remote> <branch>` and push once more.

- When your commit conflicts with the remote, run `git rebase --abort`. It restores the checkout and the other writers' changes. Keep your commit local and report it.
- When restoring the other writers' changes conflicts, Git keeps them in the stash and marks their path conflicted, which blocks every later commit. Run `git --literal-pathspecs reset -q -- <path>` to clear only the conflict state, then report the path and the stash entry. The file and the stash stay for their writer.
