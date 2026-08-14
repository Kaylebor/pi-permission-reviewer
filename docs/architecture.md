# Architecture

The extension uses two deliberately separate planes.

The execution plane owns deterministic classification, pi-perm policy,
immutable review cases, one-use approval capabilities, the per-command SRT
worker, and Boolean network responses. No bash call reaches the registered
executor without consuming a capability bound to its exact input, CWD, session
epoch, configuration generation, and frozen sandbox settings.

Contained execution is the default: each authorized command uses frozen SRT
settings. A Bash call may include exact structured filesystem, validated
public-key, Unix-socket, or SSH-agent preflight requests, and recognized Git
commands may derive narrowly scoped compatibility requests. Deterministic
`pi-perm`, classifier, and SRT denies remain authoritative except for the
documented exact validated public-key exception to the built-in blanket
`~/.ssh` deny; a more-specific configured deny still wins.

The review plane owns provider-neutral context evidence and tool-less model
calls. A `ContextLedger` follows Pi's `context` snapshots and finalized
`message_end` events. It emits either bounded redacted transcript evidence or
metadata only. Local reviewer histories contain only reviewer prompts and
responses; they do not depend on provider-side session APIs.

The extension also appends stable advisory main-agent guidance through Pi's
`before_agent_start` system-prompt hook, but only while its guarded Bash tool is
the effective active registration. The guidance explains structured capability
shape, minimum-access retries, automatic Git/network handling, and one-use
per-call authorization semantics. It is deliberately separate from enforcement
and remains available when a custom `SYSTEM.md` bypasses tool prompt guidelines.

The reviewer system prompt includes a built-in implicit-authorization rule for
bounded, task-relevant reads of repository context, project instructions,
installed skill definitions, and documentation. An optional trusted Markdown
Guardian extension is loaded with the JSON configuration, size-bounded, and
inserted ahead of the non-overridable reviewer role and response-schema
invariants. Its exact content is snapshotted into the immutable `ReviewCase`, so
the initial and reactive decisions cannot observe different prompt generations.

All permission denials are non-terminating Pi tool results. The denied action
cannot execute, but its reason returns to the agent so it can recover, choose a
different action, or request user guidance. Reviewer and human escalation—not
early turn termination—form the authority boundary.

```text
Pi tool_call
  -> pi-perm deterministic allow / authoritative block / confirmation
  -> bash classifier or built-in file-tool minimum level
  -> optional explicit Bash permissions: validate -> minimum review level
  -> review ladder / human fallback
  -> immutable ReviewCase
  -> bash: one-use ApprovalCapability -> registered executor -> SRT worker
       -> explicit deny: authoritative for that connection
       -> off-list public HTTPS: reactive review ladder
       -> structured NetworkDecision
       -> Boolean allow/deny IPC
       -> explicit or recognized Git preflight capability request
  -> read/write/edit: locked exact input -> Pi built-in executor
```

For Pi's built-in file tools, only a `pi-perm` confirmation enters the review
plane: `read` starts at level 0, while `write` and `edit` start at level 1.
The confirmation interception uses a private sentinel thrown from the
suppressed pi-perm UI request, not its eventual denial text, so deterministic
blocks remain authoritative and the probe does not create a fake user-denial audit
entry. The effective tool source is revalidated as Pi built-in before approval;
missing or replaced file executors are rejected without execution. File tools retain
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

`boundaryReview` defaults to `{ publicKeyRead: "review", gitFsmonitor: true,
gitSshAgent: "review" }`. `publicKeyRead: "review"` routes an explicit
public-key-read capability request through the reviewer chain, while `"block"`
is authoritative. The capability validates an exact owner-controlled SSH
`.pub` file and revalidates it before execution; it does not permit arbitrary
filesystem reads. Recognized Git
commands can receive platform-specific fsmonitor compatibility;
on Linux it is an invocation-local `core.fsmonitor=false` overlay. An approved
SSH-agent Git operation starts at level 1 and receives Linux's broad Unix-socket
switch only for that exact run. This disables AF_UNIX isolation and can expose
container engines and other local control sockets. `gitFsmonitor: false`
disables the compatibility path, and
`gitSshAgent: "block"` is authoritative. Local TCP binding remains unsupported.
Other commands request explicit structured preflight capabilities; they do not
reuse Git-specific settings as a generic sandbox-broadening API. Explicit read
requests start at level 0, while write/socket/SSH requests start at level 1.
They are materialized before execution into the immutable one-use capability.
The complete permission object is capped and displayed before truncated command
input during human review. There is no post-failure retry path.

Private pi-perm imports are isolated in `src/pi-perm-adapter.ts`. The adapter
requires exactly version 0.1.8 and validates every private state/module shape it
uses. Dependency upgrades therefore require an explicit adapter compatibility
review rather than relying on semver for an unpublished internal API.

The current reactive bridge covers public-looking HTTPS destinations on port
443. It cannot inspect HTTP method, path, request body, or resolved DNS address,
so it is not credential-aware authorization. Explicit filesystem and
Unix-socket requests are preflight-only and separate from that live bridge;
reactive local binding and curated known-host capabilities remain future work.
