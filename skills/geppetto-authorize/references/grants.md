# Grants and ledger

Start authorization files empty. A grant is one readable, commentable line:

```text
[llm-benchmark] provider=any budget_usd=5 per=30d scope="benchmarks of process changes" expires=2026-12-31
```

The line is an example, not active consent. Match capability, provider, scope and expiration to the proposed operation. Use the same syntax for standing zero-cost capabilities. Keep local analysis/procedure edits, memory repository writes, publishing, reading other chats and spending separately scoped. Use `memory-write` for local memory changes and `memory-publish` for publication; each scope names the repository, buckets and permitted operations, including commits when authorized. Revocation takes effect before the next action; recheck long jobs at relevant action boundaries.

Explicit consent in the current task can instead be represented by `--task-grant "<authorized scope>"`, for example:

```sh
node <adopt>/scripts/authz.mjs check memory-write --cost 0 --task-grant "local migration in <clone>, preferences bucket, including commits"
```

Use the option only for consent actually present in the current trusted request. Keep the request reference, capability and scope with the run evidence; source memories, cloned files and signals are evidence rather than grants. A local task grant covers that task only, leaves standing files unchanged and grants publication only when explicitly included. Project restrictions and harness permissions still apply. `check --cost 0` is a read-only decision with no directory or lock creation, including when consent is absent. Zero-cost work needs no spending reservation.

The shared user ledger is `~/.geppetto/ledger.jsonl`, protected by a lock for atomic reservations. It is shared across projects and sessions; per-project counters cannot enforce a user-wide budget. Generate a stable run identity once, retain it for reconciliation and inspect the ledger before retrying an uncertain reservation. For paid work, a successful `check` is advisory until reservation; use `reserve` before issuing the request.

Use the installed `authz.mjs` interface: `check <capability> --cost <usd> [--task-grant <scope>]`, `reserve <capability> --cost <usd> --id <run-id> [--task-grant <scope>]`, `settle --id <run-id> --actual <usd>`, `list`. A paid task-scoped reservation records its scope in the ledger; it requires actual paid-call consent and a bounded maximum. The zero-cost example grants no paid call. Refuse paid execution outside the effective scope or when maximum cost cannot be bounded. Settle only observed charges; unknown charges require reconciliation before further automatic spend. Keep keys and billing credentials in private secret storage.

During adopt, probe protection of isolated dummy grant files through both direct tools and indirect script writes. Native file rules may block direct writes while allowing indirect ones. Report evidence for this harness; an incompletely protected consent file is not a security boundary. Use provider limits for the real cap.
