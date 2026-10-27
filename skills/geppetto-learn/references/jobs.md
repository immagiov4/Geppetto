# Maintenance jobs

Inspect `~/.geppetto/machine.json`, live jobs and the memory repository's root `jobs.md` first. Pull its remote before proposing attachment. Reuse any machine's registration for `curate-skills` or `maintain-memory`, reporting “already scheduled on <machine>”; `--add-job <name>` requests another on this machine. Prefer the harness's native recurring tasks/automations. New jobs run weekly, Monday at 09:00 local time, using the [curation](../../geppetto-adopt/assets/templates/jobs/curate-skills.md) and [memory](../../geppetto-adopt/assets/templates/jobs/maintain-memory.md) prompts. Signal learning uses Stop.

Installation records attached jobs in `jobs.md` as `Machine | Job | Scheduler | Cadence | Registered`, commits with `Memory-Event: save` and pushes when a remote exists. Last machine-project uninstall removes this machine's rows. Git failures retain the scheduler identity for a retry. Without bucket memory, the machine registry owns job reuse.

Pass native registrations in an external JSON file to installation's `--scheduler-jobs`: each job name maps to `scheduler`, `id`, `cadence`, `nextRun` and `disable` strings. Otherwise installation uses Windows Task Scheduler (hidden launcher) or weekly cron with the subscription CLI; other cron cadences require native registration. Machine registration retains shared identities. Only an absent scheduler produces `needs-scheduler`; registration errors remain blockers. OS run output is retained in `~/.geppetto/<job>.log`. Report cadence, next run and controls in the recap.

OS jobs invoke `~/.geppetto/bin/maintenance-launcher.mjs`. Each installation refreshes that entrypoint and the registered prompt sources to the selected package. Windows retains the hidden `maintenance.vbs` launcher and task names; cron reconciles its marked entries in place while preserving their cadence and unrelated jobs. Native scheduler registrations retain their identities.

Exercise new jobs on synthetic inputs before enabling them. OS jobs reuse the [bounded learning CLI](ingestion.md), receiving machine context as input; private buckets and shell/delegation/publication tools stay excluded. Read [process execution](../../geppetto-adopt/references/processes.md) before launching tools.

## Observability

The machine registry records job identity, cadence, next run, prompt source and disable command; `jobs.md` exposes cross-machine ownership. Git synchronization failures are installation errors. Subscription output and failures appear in the per-job log; the hidden Windows launcher propagates the child exit status. Tests use two clones sharing a local bare remote to verify deduplication, explicit attachment and row removal. Upgrade tests delete the old package source and run the refreshed stable entrypoint. Synthetic schedulers preserve host jobs; live attachment is an installation check.
