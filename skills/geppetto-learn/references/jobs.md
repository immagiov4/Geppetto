# Maintenance jobs

Use the existing harness or OS scheduler. The installer records shared resources in `~/.geppetto/machine.json`; inspect both it and the live scheduler before creating jobs. Reuse equivalent jobs and preserve their cadence. Register one skill-curation job and one memory-maintenance job per machine, with the installed project list as input. Signal learning runs through the Stop hook.

Render the [learning](../../geppetto-adopt/assets/templates/jobs/learn.md), [skill curation](../../geppetto-adopt/assets/templates/jobs/curate-skills.md) and [memory maintenance](../../geppetto-adopt/assets/templates/jobs/maintain-memory.md) prompts. Reuse the existing cadence; for a new machine, schedule weekly on Monday at 09:00 in its local timezone. Store the real scheduler ID, cadence, next run and disable command in the corresponding machine registry entry. When scheduling is unavailable, record `needs-scheduler` and name that prerequisite in the installation recap.

Exercise each new job on synthetic inputs before enabling it. Jobs prepare local changes using the subscription CLI and existing procedure. Read [process execution](../../geppetto-adopt/references/processes.md) before launching tools.
