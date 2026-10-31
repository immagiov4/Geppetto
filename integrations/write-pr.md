# Reviewable pull requests

Skills: write-pr, pr

Suggested for PR preparation: bundled `write-pr` keeps a short Problem / Approach / Result opening, evidence that helps judge the change and expandable supporting details. [Matt Pocock's pr](https://github.com/mattpocock/skills/tree/main/skills/engineering/pr) is an alternative focused on a useful visual summary, evidence and merge consequences.

Source: the bundled edition is pinned in [third-party notices](../THIRD_PARTY_NOTICES.md). It is also maintained in [My Codex Skills](https://github.com/immagiov4/my-codex-skills/tree/4ce5ba501e90429e8f39dd19049f1dd7ac1d6893/skills/write-pr).

## Install

Follow the maintainer's selected PR procedure first. Otherwise use bundled `write-pr`. For a separate installation, select `write-pr` from `immagiov4/my-codex-skills` with the harness's installer. Matt Pocock's `pr` is another option: `npx skills add mattpocock/skills --skill pr`.

## With geppetto-verify

Use the project's PR format and body validator. Choose a before/after table, screenshots or a short video, execution evidence, or a small structural diagram when it helps the reviewer; a trivial change may be clear from its explanation and linked diff. Keep supporting detail expandable and use reviewer-accessible evidence links. Put material reversibility and affected scope together at the end. Pair the procedure with Writing for Humans or the maintainer's selected prose simplifier, such as unslop; the PR procedure owns structure and evidence while the companion improves language. The specification already owns the technical observability design; the PR reports its verification.
