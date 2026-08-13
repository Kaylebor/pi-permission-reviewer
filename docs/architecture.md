# Architecture

The extension uses two deliberately separate planes.

The execution plane owns deterministic classification, pi-perm policy,
immutable review cases, one-use approval capabilities, the per-command SRT
worker, and Boolean network responses. No bash call reaches the registered
executor without consuming a capability bound to its exact input, CWD, session
epoch, configuration generation, and frozen sandbox settings.

The review plane owns provider-neutral context evidence and tool-less model
calls. A `ContextLedger` follows Pi's `context` snapshots and finalized
`message_end` events. It emits either bounded redacted transcript evidence or
metadata only. Local reviewer histories contain only reviewer prompts and
responses; they do not depend on provider-side session APIs.

```text
Pi tool_call
  -> pi-perm deterministic allow / terminal block / confirmation
  -> bash classifier or built-in file-tool minimum level
  -> review ladder / human fallback
  -> immutable ReviewCase
  -> bash: one-use ApprovalCapability -> registered executor -> SRT worker
       -> explicit deny: terminal
       -> off-list public HTTPS: reactive review ladder
       -> structured NetworkDecision
       -> Boolean allow/deny IPC
  -> read/write/edit: locked exact input -> Pi built-in executor
```

For Pi's built-in file tools, only a `pi-perm` confirmation enters the review
plane: `read` starts at level 0, while `write` and `edit` start at level 1.
The confirmation interception uses a private sentinel thrown from the
suppressed pi-perm UI request, not its eventual denial text, so deterministic
blocks remain terminal and the probe does not create a fake user-denial audit
entry. The effective tool source is revalidated as Pi built-in before approval;
missing or replaced file executors are terminally rejected. File tools retain
exact-input locking but do not use the bash approval capability or claim SRT
coverage. Pi-perm's `audit.jsonl` records the policy-stage confirmation handoff,
not the later reviewer result or proof that the built-in executor ran.

Command persistence creates a separate reviewer history for each case and
model, reuses the winning history for reactive review, and deletes it when the
command settles. Session persistence keeps one bounded history per model and
serializes calls to that history. Session boundaries and configuration reloads
clear histories, approvals, cached evidence, and pi-perm's private session
grants; they also abort active sandbox executions.

Reactive review resumes the winning reviewer from the original permission case.
Its continuation reasoning is configurable and defaults to one step below the
winner's configured effort with a low floor. The original evidence is already
present in that local history and is not duplicated. Availability fallbacks and
higher-level escalation reviewers keep their configured effort and receive the
full evidence packet when they have not seen the case.

Private pi-perm imports are isolated in `src/pi-perm-adapter.ts`. The adapter
requires exactly version 0.1.8 and validates every private state/module shape it
uses. Dependency upgrades therefore require an explicit adapter compatibility
review rather than relying on semver for an unpublished internal API.

The current reactive bridge covers public-looking HTTPS destinations on port
443. It cannot inspect HTTP method, path, request body, or resolved DNS address,
so it is not credential-aware authorization. Filesystem, Unix-socket, local
binding, and curated known-host capabilities remain separate future work.
