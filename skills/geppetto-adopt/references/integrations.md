# Optional integrations

The package catalog lives in `integrations/<companion>.md`, one file per companion with installation instructions, evidence status and `## With geppetto-<skill>` subsections. The installer, weekly curate job and SessionStart refresh `~/.geppetto/integrations.md` from installed harness skills and plugin inventories. Cached plugin skills qualify through an installed parent plugin; stale cache directories alone do not establish installation. Each Geppetto skill reads its applicable section when invoked. SessionStart refreshes the file without injecting companion text. Generated skill installations retain a catalog copy under geppetto-adopt so they can refresh independently of the source checkout.

Adoption suggests at most three catalog companions; curation uses observed skill reads and evidence to explain relevant suggestions. An explicit yes authorizes installation through the catalog's harness procedure. Availability establishes a reading path, while measured benefit requires a project comparison. A recurring pairing may justify a local catalog proposal through geppetto-learn; upstream publication follows a requested PR.

The bundled and host skills may require companion skills outside this pack. When that branch applies, resolve the companion by name in the project's skill directories first, then the harness's global/user skill directories or installed plugins. Read the resolved `SKILL.md` and record its name, source path and scope in `.geppetto/config.json` `packs`; a global installation satisfies resolution without copying it into the project. Preserve project-local precedence and the task's authority.

If a required companion is absent everywhere, report its name and blocked branch and use only a substitute explicitly permitted by the owning skill or project. Installation follows the task's existing authorization. Optional companions use the alternatives below.

- `writing-for-humans`: use it for human prose when installed; otherwise follow the project's writing rules and reread for supported meaning and audience.
- `agent-question-notifications`: use its persistent notice mechanism when installed and applicable; otherwise leave the decision in the original conversation and maintain the pause only on dependent work.
- An issue-governance skill: use before authorized issue mutations when installed; otherwise follow the project's issue rules and publication authorization.
- `skill-creator`: use the harness's installed validator; otherwise inspect `name`, `description`, references and observable completion criteria directly.
- `tdd`, `grilling`, `to-spec`, `to-tickets`, pstack and extra principle packs: optional development choices discovered by adopt. Record them in `packs`; keep the Geppetto principles complete.

Portable local links in the bundled copies route here where the canonical collection referenced an unbundled companion. That changes resolution, not the companion's rules or the user's authority.
