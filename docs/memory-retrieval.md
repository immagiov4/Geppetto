# Memory retrieval

At session start the memory hook lists every configured bucket and supplies the full indexes of the project-linked buckets. The agent follows these links through `$geppetto-memory`, searches the authorized topics and opens relevant pages. Preferences remain global; project selections define the linked indexes. Private page contents require an explicit user request.

## Observability

Session context records its status, injected bytes and zero model calls in the local hook-event log. An unavailable configured memory reports a redacted reason. Prompt events produce no memory-classifier request, spending reservation or suggestion, including when an older configuration still enables that classifier.

## Verification

Synthetic hook tests verify session listings, linked indexes, private-content exclusion and unavailable memory. A regression exercises a legacy enabled classifier configuration and proves that a prompt neither contacts a provider nor reserves spending. Plugin and standalone registrations retain SessionStart memory retrieval and per-message skill selection.
