<p align="center">
  <img src="assets/geppetto-transparent.png" width="220" alt="Geppetto, the old woodcarver, in pixel art">
</p>

<h1 align="center">Geppetto</h1>

<p align="center">
  <em>Make the skills you already use measurable — and let the agent improve them over time</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/works%20with-Claude%20Code%20%C2%B7%20Codex-3f7877?style=flat-square" alt="Works with Claude Code and Codex">
  <img src="https://img.shields.io/badge/skills-18-783b18?style=flat-square" alt="18 skills">
  <img src="https://img.shields.io/badge/node-%E2%89%A522-83624c?style=flat-square" alt="Node 22 or later">
  <img src="https://img.shields.io/badge/license-MIT-b56315?style=flat-square" alt="MIT license">
</p>

[Matt Pocock's skills](https://github.com/mattpocock/skills) and [pstack](https://github.com/backnotprop/pstack) already tell an agent how to work, and they are worth keeping, but a pack of procedures still leaves two questions open: which of those procedures actually help on your work, and how the agent gets better after a bad turn without you rewriting the skills by hand.

A skill can sit installed and never be called, and the same friction can show up twice and die with the chat, because nothing in the harness records it as a lesson. Google Research's [Harness²](https://github.com/google-research/harness2) will rewrite the harness around the model so that kind of improvement can happen, which also means leaving Claude Code or Codex and the skills you already trust.

Geppetto stays in that harness instead of replacing those packs. It adds the missing conditions for learning — a record of what happened, a measurement before a rule or skill edit is kept, and work small enough that a lesson has somewhere to attach — so recurring friction can go back into a script, a skill, the docs, or memory. Adopt, specify, build, and verify exist for that reason, not as a second methodology: your test framework, tracker, and other skill packs stay yours.

<p align="center">
  <img src="assets/readme/loop.png" width="880" alt="Adopt, specify, build, verify and learn: stages of a change, with shared principles underneath.">
</p>

## Install

**Claude Code**

```bash
/plugin marketplace add immagiov4/geppetto
/plugin install geppetto@geppetto
```

**Codex**

```bash
codex plugin marketplace add immagiov4/geppetto
codex plugin add geppetto@geppetto
```

**Any agent that reads `.agents/skills`** (OpenCode, Pi and others; untested)

```bash
git clone https://github.com/immagiov4/geppetto
node geppetto/skills/geppetto-adopt/scripts/install.mjs --target agents --project <your-repo> --dry-run
```

Review the dry-run, then rerun without `--dry-run`. In the project, ask:

```
Install Geppetto on this project.
```

An installation request, including this repository link, authorizes adoption. After installing the plugin, the agent reads `skills/geppetto-adopt/SKILL.md` from its installed path and completes project installation in the same session. A fresh session loads the plugin's hooks and skills for later work. Adoption reuses plugin skills, connects maintenance jobs, preserves project rules and finishes with a local `geppetto-install` commit and a recap. An existing OpenRouter key enables semantic screening for `requirements-blast-radius`; a missing key receives one optional offer. [Installation details](skills/geppetto-adopt/references/installation.md), [architecture](docs/system-map.md), [development](docs/development.md).

## Limits

- **Semantic screening costs.** Source screening uses the OpenRouter key from the environment and reports provider usage. Put a hard spending limit on the key; a local maximum cannot bound a request whose final charge is unknown.
- **Two harnesses tested.** Claude Code and Codex. Pi and OpenCode can load the skills; nobody has trialled them there yet.
- **Harness loading and hook trust.** Installation checks files and native hook hashes; verify actual hook and skill loading in a fresh session. Codex project layers also require project trust.
- **Maintenance scheduling.** Periodic jobs need an available harness or OS scheduler; the recap names missing prerequisites. Subscription learning uses the installed CLI account and its available tools.
- **First CI run** on the PR that introduces Geppetto needs an owner-pinned Geppetto commit. [CI bootstrap](skills/geppetto-adopt/assets/templates/ci/README.md).

<details>
<summary>How a lesson is kept</summary>

Some of the principle skills look familiar, such as behaviour tests, living docs, and measure-before-keep, because the learning loop has nothing to stand on without a minimum of visibility and measurement. They are not there to replace your methodology: other packs install alongside, adoption records the tools you already have, and how you write a specific test stays yours.

<p align="center">
  <img src="assets/readme/lesson.png" width="880" alt="Lessons go to scripts, skills, project documentation, or memory according to what they describe.">
</p>

When the same friction keeps returning, a signal can be recorded, and `geppetto-learn` separates what was observed from a guess at the cause before it puts the fix in the first place that can hold it: an enforceable check, a procedure, the documentation that already owns the fact, or memory. A process change is measured before it is kept, so a guess does not become a rule on its own.

<p align="center">
  <img src="assets/readme/memory-flow.png" width="880" alt="Memory repository, project index loaded at startup, and relevant pages read when needed.">
</p>

Generalizable lessons and decision rationale live in a Git repository of Markdown, grouped into buckets. Installation offers a local folder, a private GitHub repository, each tool's own memory or no memory. With bucket memory, Claude can write natively into the project bucket; the session hook supplies linked indexes. The agent follows these indexes to retrieve relevant pages. [Memory retrieval](docs/memory-retrieval.md).

</details>

<details>
<summary>Skill and script inventory</summary>

| | |
|---|---|
| **Procedures** | `geppetto-adopt`, `geppetto-spec`, `geppetto-build`, `geppetto-verify`, `geppetto-learn`, `geppetto-memory` |
| **Principles** | `geppetto-measure-it`, `geppetto-x-ray`, `geppetto-reuse-it`, `geppetto-living-docs`, `geppetto-behaviour-tests` |
| **Bundled** | `writing-for-agents`, `requirements-blast-radius`, `skill-learning-patterns`, `code-review`, `receive-work-feedback`, `retro` (optional), `write-pr` (fallback when no PR procedure is selected) |
| **Scripts** | `audit`, `install`, `gate-sections`, `gate-agents`, `signal`, `memory-hook`, `learn-nudge`, `learn-runner`, `machine`, `migrate-agents`, `host-lint` |

Bundled copies keep provenance in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

</details>

## License

MIT. Bundled skills keep their own MIT notices; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Influenced by [Matt Pocock's skills](https://github.com/mattpocock/skills), [pstack](https://github.com/backnotprop/pstack), and [OpenRig](https://github.com/mvschwarz/openrig).

Contributors: enable the version checks with `git config core.hooksPath .githooks`.
