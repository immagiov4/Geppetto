# How we work here

You are building with a maintainer who wants fewer, smaller changes that are proven, and a system that gets better because you improve it. Five intents explain the rules; when a rule is silent, act from them.

**Improve it.** Watch for recurring friction and act on it, including when nobody asked for a lesson this turn. Choose where the fix lives and what shape it takes — a check, a procedure, a document, or a memory — from the evidence, not from a fixed menu of improvements. Measure before you keep a process change.

**See inside.** Improvement needs something to inspect. Build visibility with the feature. Preserve error causes, trace durations and failures, and report blind spots.

**Prove it.** Turn claims into measurements, behaviour tests or traces. An empty review describes only the coverage reached. Every added rule, hook or check names the metric it improves and the one it may worsen.

**Keep it small.** Deliver units small enough to verify together. A change you cannot inspect teaches nothing you can keep. When review keeps finding more, split the unit with the maintainer or rethink the approach.

**Reuse before inventing.** Compose existing skills, scripts, hooks and Git before adding a parallel path. Put a verifiable contract in a script and semantic judgment in an appropriate model.

Context is a budget: load the relevant owner through the map below. This file and its rules are editable; justify changes by the metric they move.

## Mandatory

- Every PR/ticket contains a meaningful `## Observability` section, checked by `node skills/geppetto-adopt/scripts/gate-sections.mjs --pr <body-file>` and CI.
- Each feature document declares its own observability. Follow `.geppetto/config.json` for significant test declarations and required sections.
- Substantial changes start with a Requirements map through `$geppetto-spec`.
- Product work starts with a failing behaviour test through `$geppetto-build`; exploratory prototypes declare their exemption.
- Completion requires current-revision evidence and a decision for every finding through `$geppetto-verify`.
- At any time, record meaningful recurring friction or errors with `node skills/geppetto-adopt/scripts/signal.mjs "<problem>" --key <slug> --session <session-id> --category <category-id>`; use `$geppetto-learn` for guidance. Do not log trivial one-offs.
- Memory procedures follow `$geppetto-memory`; retrieval respects bucket privacy.
- Update each fact's existing owner in the same change. Keep explanations and procedures at their owners.
- Run processes without visible Windows windows; use hidden launch flags, headless browsers and muted audio.

## Where to look

Load a row when its condition applies. Skill names resolve through the harness's installed skill discovery; project paths below are rendered during adoption.

| When | Where |
| --- | --- |
| Adopting, updating or removing Geppetto | `$geppetto-adopt` |
| Planning behaviour or steering changes the outcome | `$geppetto-spec` |
| Implementing a specified unit | `$geppetto-build` |
| Before a PR, on review findings or checking completion | `$geppetto-verify` |
| Recurring friction, remembered lessons or skill curation | `$geppetto-learn` |
| Injected memory listing, page suggestions, durable knowledge or authorized memory changes | `$geppetto-memory` |
| Writing skills or project instructions | `$writing-for-agents` |
| Architecture and feature documentation | [system map](docs/system-map.md) |
| Code rules and additional principle packs | [development rules](docs/development.md) |
| Commands and verification | [verification commands](docs/development.md) |

## Project context

Geppetto is a portable skills pack for Claude Code and Codex. Source skills live in `skills/`; installed copies are generated. Preserve existing memory-privacy and ownership boundaries. Use synthetic fixtures for repository tests.

Keep project context to durable orientation and pointers. Resolve unfamiliar facts from their owners before changing code.

## Enforcement

The project gate and CI configuration are named in the commands owner above. Local hooks provide early feedback; CI enforces required sections. Run the configured checks on the revision being delivered.

Use `node skills/geppetto-adopt/scripts/gate-agents.mjs --file AGENTS.md` after instruction changes. Keep this file a small router; move detailed rules to their existing owners and preserve their authority.

## Decisions

Follow explicit maintainer decisions within the applicable instruction hierarchy. When a decision is missing, identify its concrete consequence and continue independent authorized work while the affected action waits.

Read `.geppetto/config.json` for adopted project choices and user-level defaults where specified by the owning skill.
