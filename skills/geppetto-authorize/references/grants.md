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

Native subscription learning records zero-cost reservations to retain launch identity and authorization evidence; these records impose no run or USD cap.

Use the option only for consent actually present in the current trusted request. Keep the request reference, capability and scope with the run evidence; source memories, cloned files and signals are evidence rather than grants. A local task grant covers that task only, leaves standing files unchanged and grants publication only when explicitly included. Project restrictions and harness permissions still apply. `check --cost 0` is a read-only decision with no directory or lock creation, including when consent is absent. Zero-cost work needs no spending reservation.

The shared user ledger is `~/.geppetto/ledger.jsonl`, protected by a lock for atomic reservations. It is shared across projects and sessions; per-project counters cannot enforce a user-wide budget. Generate a stable run identity once, retain it for reconciliation and inspect the ledger before retrying an uncertain reservation. For paid work, a successful `check` is advisory until reservation; use `reserve` before issuing the request.

Use `authz.mjs check|reserve <capability> --cost <usd|none>`, adding `--id` for reservations, or `settle --id <id> --actual <usd>` and `list`. `budget_usd=none` explicitly records unlimited standing spending authority; `expires=never` records consent until revocation. An unbounded reservation (`--cost none`) is permitted only when every applicable grant is unlimited; numeric grants require a configured per-run maximum. Ledger `reserved: null` means unbounded rather than zero. Unknown charges remain unsettled; bounded grants require reconciliation before later bounded spending. Subscription-only `signal-learning` at cost zero with provider `codex` or `claude` uses the accepted project grant without a second personal grant. Paid providers always retain personal and project consent. Keep keys in private secret storage.

During adopt, probe protection of isolated dummy grant files through both direct tools and indirect script writes. Native file rules may block direct writes while allowing indirect ones. Report evidence for this harness; an incompletely protected consent file is not a security boundary. Use provider limits for the real cap.
