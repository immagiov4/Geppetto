<p align="center">
  <img src="assets/geppetto-transparent.png" width="220" alt="Geppetto, the old woodcarver, in pixel art">
</p>

<h1 align="center">Geppetto</h1>

<p align="center">
  <em>Engineering skills for Claude Code and Codex</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/works%20with-Claude%20Code%20%C2%B7%20Codex-3f7877?style=flat-square" alt="Works with Claude Code and Codex">
  <img src="https://img.shields.io/badge/skills-18-783b18?style=flat-square" alt="18 skills">
  <img src="https://img.shields.io/badge/node-%E2%89%A522-83624c?style=flat-square" alt="Node 22 or later">
  <img src="https://img.shields.io/badge/license-MIT-b56315?style=flat-square" alt="MIT license">
</p>

Geppetto is a collection of skills and scripts for coding agents. It helps an agent understand a request, make a small change, verify the result, and keep useful lessons for later work.

The pack uses the skills, hooks, and Git tools already available in Claude Code and Codex. Its procedures cover project adoption, planning, implementation, verification, and learning from recurring problems. The scripts require Node 22 or later.

## How it works

### Shared instructions

`AGENTS.md` is the entry point for each session. It contains the project’s intent, mandatory rules, and a map of when to read more detailed instructions. Procedures and reference material stay in their own files and are loaded when the task calls for them. Claude Code reads the same instructions through a one-line `CLAUDE.md` import.

During adoption, Geppetto reads the existing instructions, tools, and documentation before proposing changes. It preserves working conventions and asks for decisions about documentation style, review tools, optional hooks, memory, and spending permissions. If you want a different documentation structure, you can provide a repository as a reference.

### The change procedure

<p align="center">
  <img src="assets/readme/loop.png" width="880" alt="Adopt, specify, build, verify and learn: the stages of a change, supported by shared principles.">
</p>

| Skill | What it does |
|---|---|
| `geppetto-adopt` | Audits the repository and existing tools, proposes the instruction changes and installation, then verifies what a fresh session loads. |
| `geppetto-spec` | Starts with the user flow and design constraints, then maps the affected surfaces, callers, and lifecycle boundaries. Splits the work into small verifiable units. |
| `geppetto-build` | Writes a behaviour test that fails for the right reason, then changes the code at its existing owner and checks related callers. |
| `geppetto-verify` | Runs checks suited to the risk and requests a review in a fresh context. Confirms each finding against the code and evidence before deciding on a correction. |
| `geppetto-learn` | Examines recurring problems and updates the script, skill, documentation, or memory that owns the lesson. |

### Supporting principles

The procedures call five short principle skills when relevant:

| Skill | Responsibility |
|---|---|
| `geppetto-measure-it` | Defines what a claim or proposed rule should improve, measures the starting point, and compares the result. |
| `geppetto-x-ray` | Builds observability into the feature so its behaviour and failures can be inspected; preserves technical error details for diagnosis. |
| `geppetto-reuse-it` | Looks for existing code, tools, and standard facilities before adding new machinery. |
| `geppetto-living-docs` | Gives each fact an authoritative home and updates or reorganizes documentation when the system changes. |
| `geppetto-behaviour-tests` | Tests observable results through the interfaces used by callers. |

These skills remain complete when installed alongside other principle packs. Adoption records the existing tools and the review system you choose; bundled review skills are included unless you select a replacement.

### Automated checks and spending permissions

Scripts check rules that can be enforced mechanically. Pull requests and tickets require an `## Observability` section; the instruction-file checker enforces the router's size budget. The pull-request workflow checks the required sections in CI. Adoption configures where a ticket check belongs for the project's tracker.

Paid experiments use explicit authorization records. Personal permissions define the available scope and budget; project permissions can restrict them further. Reservations account for concurrent runs before spending, and settlement records the actual cost. Provider-account limits remain the spending boundary because hooks cannot prevent every possible file write.

## Where lessons are kept

<p align="center">
  <img src="assets/readme/lesson.png" width="880" alt="Lessons go to scripts, skills, project documentation, or memory according to what they describe.">
</p>

At the end of a long turn, a deterministic hook asks the agent whether a difficulty kept recurring. When there is a useful signal, the agent records its scope and the metric it affects. The hook itself needs no model call or API key; the agent's response uses the session's normal model usage.

Signal learning is enabled when an authenticated subscription CLI and the accepted adoption grant are present. Codex uses `gpt-6.1-sol` on the default service tier; Claude is the alternative when Codex is absent. The agent judges whether a workflow, verified fix, user correction or recurring cause merits learning. Run and spending caps apply only when you configure them. Improvements are committed on isolated local branches; set `hooks.signalLearning.writeApproval` to true to retain staged changes for review.

`geppetto-learn` examines the signal, separates the observation from its possible cause, and chooses the first suitable place for a lasting correction: an enforceable rule goes into a script, hook, or test; a procedure goes into a skill; a description of the system goes into its documentation. Memory holds durable facts that have no better home. A proposed process change is measured before it is retained.

## How memory reaches a session

Memories live in one private Git repository of Markdown files, grouped into buckets: one per project, plus global topics such as working preferences. Each bucket has an index linking to its pages. Pages describe the current facts; Git history records how they changed. Agents with file and Git access can use the same repository across their development environments.

<p align="center">
  <img src="assets/readme/memory-flow.png" width="880" alt="Memory repository, project index loaded at startup, and relevant pages read when needed.">
</p>

The repository is configured once at user level in `~/.geppetto/config.json`; a project selects its linked buckets in its own configuration. At session start, the hook supplies the repository location, a one-line description of every bucket, and the full indexes of the selected buckets. It excludes the private bucket's index. The agent then follows index links to read relevant pages as the task develops.

This startup context works without an API key. An optional OpenRouter classifier can choose relevant buckets and follow selected subtopic indexes recursively to suggest pages for each request. It operates when its key, selected settings and standing data-and-spending grant are present. Adoption records consent once and shows comparison results as evidence for tuning. Private retrieval requires explicit access scope.

## Install

**Claude Code**

```
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

For the manual installation above, review the proposed files and rerun the command without `--dry-run` to install them.

After installation, open your project and ask the agent:

```
I want to follow Geppetto on this project.
```

`geppetto-adopt` shows the proposed changes to your instructions, installs the checks and hooks you approve, and verifies that a fresh session loads them.

## Included skills and scripts

<details>
<summary>18 skills and the scripts behind them</summary>

| | |
|---|---|
| **Procedures** | `geppetto-adopt`, `geppetto-spec`, `geppetto-build`, `geppetto-verify`, `geppetto-learn`, `geppetto-memory`, `geppetto-authorize` |
| **Principles** | `geppetto-measure-it`, `geppetto-x-ray`, `geppetto-reuse-it`, `geppetto-living-docs`, `geppetto-behaviour-tests` |
| **Bundled** | `writing-for-agents`, `requirements-blast-radius`, `skill-learning-patterns`, `code-review`, `receive-work-feedback`, `retro` (optional) |
| **Scripts** | `audit`, `install`, `gate-sections`, `gate-agents`, `authz`, `signal`, `memory-hook`, `learn-nudge`, `migrate-agents`, `host-lint` |

Bundled skills are pinned copies with their provenance in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Your own principle packs install alongside; Geppetto's skills stay complete either way.

</details>

## Limits

- **Two harnesses tested.** Claude Code and Codex are the targets. Pi and OpenCode can load the skills, but nobody has run a trial there yet.
- **Codex project hooks need your approval.** Codex runs a repository's hooks only after you trust them (`/hooks`). Until then, the project instructions and skills remain available; hooks run after approval.
- **Hooks are not a sandbox.** They block direct writes to the authorization file, not a script that writes it. Put the real spending cap in your provider account.
- **The first CI run** on the pull request that introduces Geppetto needs an owner-pinned Geppetto commit. See the [CI bootstrap setup](skills/geppetto-adopt/assets/templates/ci/README.md) for the repository variables and trust boundary.

## License

MIT. Bundled skills keep their own MIT notices; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Built on ideas from [Matt Pocock's skills](https://github.com/mattpocock/skills), [pstack](https://github.com/backnotprop/pstack) and [OpenRig](https://github.com/mvschwarz/openrig).
