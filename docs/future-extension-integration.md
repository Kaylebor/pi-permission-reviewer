# Future inter-extension integration

This document records design ideas, not supported APIs or current security
guarantees.

The Bash tool currently accepts explicit structured preflight permissions, but
no public inter-extension integration API exists. This extension owns its
execution path; another extension cannot broaden a sandbox or consume an
approval. Any future cross-extension capability request must begin as an
internal, versioned interface with adversarial tests before a public contract is
considered.

## Current state

Pi composes extensions ambiently. Each loaded extension may register a
`tool_call` handler, and Pi invokes those handlers in extension order until one
blocks. `pi-permission-reviewer` embeds one pinned pi-perm engine and registers
a capability-guarded bash implementation. It owns the effective bash
execution boundary only when that registration wins Pi's tool slot; it is not a
service automatically reused by another package merely because that package
depends on `pi-perm`.

`pi-perm` 0.1.8 is distributed primarily as a Pi extension. Its core modules
can be imported from package-internal paths, but they are not a documented,
typed, versioned embedder contract. This project isolates those private imports
behind `src/pi-perm-adapter.ts`, requires the exact version, validates the
runtime shape, and fails closed when the contract differs.

Ambient loading is appropriate for separate child Pi sessions. For example,
`pi-subagents` normally starts a child Pi process with ambient extension
discovery, so this package loads again inside that process and guards its Pi
tool calls when it owns the effective tool slot. This does not share approvals,
reviewer histories, or configuration generation state with the parent. Explicit
extension restrictions can exclude the package and must remain visible in
launch diagnostics. Presence or runtime acknowledgement proves loading at most,
not that this package owns the active bash executor or remains healthy.

The parent's outer `subagent` invocation is a non-bash Pi tool call, but the
launcher extension's process creation, worktree operations, hooks, sharing, and
other internal effects do not pass through this package's bash executor. The
child's subsequent Pi tool calls are a separate enforcement boundary.

Ambient hooks do not mediate arbitrary code executed by another extension.
Direct calls to `child_process.spawn()`, filesystem APIs, or network clients do
not emit a Pi tool call. The model cannot directly call those APIs, but
extension tools, commands, event handlers, timers, or background work can invoke
them without a new tool call. A custom tool that wraps them expands the trusted
computing base and can bypass this gate after its outer tool call is allowed.

## Goals

A future composition contract could let cooperative extensions:

- declare the effects and capabilities they intend to expose;
- request an explicit, narrowly structured preflight capability;
- ask whether a structured Pi tool action is admissible without duplicating
  pi-perm state;
- execute approved OS effects through the same immutable capability and sandbox
  boundary rather than receiving a reusable Boolean approval;
- impose monotonic capability ceilings on child sessions;
- report whether a child launch actually loaded the required gate; and
- participate in cancellation, audit, session invalidation, and configuration
  generation changes.

It should not attempt to sandbox malicious code already executing inside the Pi
process. It should not let an extension mint approvals, convert an approval for
one input into another, or treat package dependency presence as proof that a
gate is active. Protecting against malicious extensions requires least-privilege
isolation of the whole Pi process in an operating-system sandbox, container, or
virtual machine; no in-process broker can provide that boundary.

## Possible layers

### 1. Upstream pi-perm engine contract

The cleanest upstream boundary would separate policy from Pi registration:

- a typed, documented `createPermissionEngine()` API;
- immutable structured decisions rather than `undefined` for allow;
- explicit session reset and configuration-generation lifecycle methods;
- supported translation from an effective profile to SRT settings; and
- a separate `createPiExtension()` adapter that registers ordinary Pi hooks.

This would remove this project's private imports, but would not by itself make
direct extension-side effects safe.

### 2. Process-local cooperative broker

This package could first define a versioned internal broker interface behind its
own execution boundary. It is not a public package API, process-global registry,
or a general inter-extension approval service. Any later cooperative discovery
mechanism would need duplicate-owner detection, version negotiation, explicit
disposal on reload, bounded metadata, fail-closed behavior when a required
broker is absent, and an explicit decision to widen the supported API surface.

The broker should avoid an API shaped like `approve(input): boolean`. A safer
flow is:

1. Submit a canonical action description and caller identity.
2. Create an immutable review case.
3. Return an opaque, one-use capability bound to the action digest, CWD,
   session epoch, configuration generation, and policy snapshot.
4. Consume that capability only inside a broker-owned executor or supported
   sandbox adapter.
5. Revoke outstanding capabilities on cancellation, reload, or session change.

Cooperative preflight may improve UX, but execution-time enforcement remains
authoritative.

### 3. Child-session launch attestation

Launchers such as `pi-subagents` can continue using ambient discovery while
performing a pre-model handshake that verifies the required package version,
health, and effective executor ownership. The launcher should fail before the
first model turn when that requirement is absent or conflicted. An optional
capability ceiling could require the permission gate, limit child tools, and
prevent a model-controlled launch from disabling extensions. The child still
owns an independent permission session; parent approvals must not be copied
into it.

Cross-process RPC to a parent reviewer is not initially necessary and would add
availability, authentication, cancellation, and confused-deputy risks. Prefer
an independently loaded child gate unless a concrete use case requires shared
coordination.

## Security requirements

Any implementation should include:

- caller identity and action-schema validation;
- exact input, tool-call, CWD, policy-generation, and session binding;
- one-shot atomic capability consumption;
- deterministic-deny precedence that integrations cannot override;
- no raw secret or unrestricted transcript transport;
- bounded queues, timeouts, cancellation, and process-tree cleanup;
- audit records that distinguish policy, model, human, and integration sources;
- duplicate-provider and extension-order tests;
- effective bash-owner checks that fail closed on a competing override;
- explicit behavior for headless sessions and unavailable reviewers;
- ambient-extension exclusion tests for child Pi processes; and
- macOS and Linux runtime coverage before a portability claim.

## Suggested sequence

1. Propose a stable typed engine API upstream to pi-perm.
2. Add a startup/runtime self-check of Pi's effective bash tool source and fail
   closed on conflicting ownership. This protects against accidental or
   cooperative conflicts, not malicious in-process code.
3. Define a narrow capability-ceiling contract for cooperative launchers.
4. Add a child pre-model handshake that requires the expected gate version,
   health, and active executor ownership.
5. Prototype a process-local broker only for a real integration that cannot use
   normal Pi tools.
6. Add an executor-owned capability flow before permitting arbitrary custom
   tools to rely on the broker.
7. Keep ambient `tool_call` enforcement as the default even after cooperative
   APIs exist.
