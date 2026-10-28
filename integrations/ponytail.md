# Ponytail

Skills: ponytail, ponytail-review

[DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) pushes the agent toward the smallest change that does the job; `ponytail-review` reviews with that lens. Useful for fixed, narrow tasks and subagent reviews.

Status: suggested.

## Install

Claude Code: `claude plugin marketplace add DietrichGebert/ponytail`, then install `ponytail` from it. Codex: `codex plugin marketplace add DietrichGebert/ponytail`, then `codex plugin add` it.

## With geppetto-build

Use it to pick the smallest change that still covers every point of the requirements map.

## With geppetto-verify

Use `ponytail-review` as the review lens for small, fixed-scope changes.

## With geppetto-living-docs

Ponytail discourages new files; the documentation layout agreed in `foundations` still applies.
