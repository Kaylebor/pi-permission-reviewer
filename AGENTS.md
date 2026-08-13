# Repository guidance

## Current security boundary

- The extension mediates Pi `tool_call` events. Tiered model review applies to
  agent-issued `bash` and to `pi-perm` confirmation decisions for Pi's built-in
  `read`, `write`, and `edit` tools. Deterministic file-tool allows and blocks
  remain pi-perm decisions; arbitrary non-bash tools remain outside the
  reviewer chain.
- File-tool review is valid only while Pi's effective tool source remains the
  built-in executor. Treat a missing or overridden `read`, `write`, or `edit`
  source as an authoritative block.
- The registered bash executor must consume a one-use approval capability bound
  to the exact tool-call ID, input, CWD, configuration generation, session
  epoch, and frozen sandbox settings.
- Deterministic denies are authoritative for the exact action. Reviewers cannot
  weaken pi-perm or SRT policy. Permission results must not set Pi's `terminate`
  flag: return the reason as a blocked tool result so the agent can continue
  autonomously. Reviewer calls remain tool-less, bounded, and fail closed.
- The built-in Guardian prompt treats bounded task-relevant repository,
  instruction, skill-definition, and documentation reads as implicitly
  authorized. Do not broaden this to secrets, credentials, unrelated personal
  data, broad discovery, writes, execution, or network access.
- Pi extensions are trusted in-process code. Direct filesystem, network, or
  `child_process` use by another extension is not intercepted. Never claim that
  this package mediates every effect of Pi or sandboxes other extensions.
- A model-facing custom tool that spawns or performs effects internally is
  outside this package's execution boundary once its outer call is allowed.
  New integrations should route effects through Pi's guarded tools or an
  equivalent capability-bound sandbox broker.
- Contained Sandbox Runtime execution is the default. `boundaryReview` enables
  recognized Git preflight compatibility; deterministic pi-perm, classifier,
  and SRT denies always take precedence. Linux SSH-agent approval necessarily
  enables Unix sockets broadly for that exact invocation.
- Git fsmonitor uses an invocation-local compatibility overlay, while approved
  Git SSH access has a one-run broad Unix-socket tradeoff. Local binding is
  unsupported everywhere.
- The Bash schema exposes explicit `permissions.read`, `permissions.write`,
  `permissions.unixSockets`, and `permissions.sshAgent` preflight requests.
  Keep them exact-input-bound, one-use, capped, and subordinate to deterministic
  denies. Never infer them from failed-command text or retry a failed command.
- SRT 0.0.71 grants bind and connect together for an exact macOS Unix-socket
  pathname and disables AF_UNIX isolation on Linux. Present the resulting
  Docker, Podman, and local-service control risk to reviewers; it does not
  permit local TCP binding. Such requests start at level 1 or higher.
- No public inter-extension integration API exists. Keep the Bash permission
  contract internal to this package's registered execution boundary until a
  separate versioned broker has concrete consumers and adversarial tests.

## Dependency and integration invariants

- `pi-perm` is bundled and pinned exactly to 0.1.8. Its programmatic core is a
  private, untyped seam: keep all imports inside `src/pi-perm-adapter.ts`, retain
  runtime shape/version validation, and require an explicit compatibility audit
  before changing the version.
- Do not load standalone `pi-perm` or another approval extension beside this
  package without analyzing handler order, duplicate prompts, bash-tool
  replacement, and fail-closed behavior.
- Ambient extension discovery is the present integration mechanism for child Pi
  processes such as `pi-subagents`. Each child owns separate reviewer state.
  Explicit extension allowlists or extension-denying ceilings may exclude this
  package; dependency presence alone does not load or compose it.
- Never treat installed or runtime-acknowledged extension presence as proof that
  this package owns the effective bash executor. A competing bash registration
  can bypass capability consumption and SRT execution. Reject competing bash
  overrides in any profile described as securely gated.
- `pi-subagents` runner-side process launches, worktree operations, hooks, and
  other extension internals are outside this sandbox. Only the child's later Pi
  tool calls can be independently gated, subject to extension loading and
  effective tool ownership.
- Direct process-local integration APIs are future design work, not supported
  behavior. Keep proposals in `docs/future-extension-integration.md` until a
  versioned contract and adversarial tests exist.
- Treat pi-perm's `audit.jsonl` as policy-stage telemetry, not a final approval
  or execution ledger. A file confirmation entry records a review handoff.
- `guardianPromptFile` is trusted user-authored system guidance. Keep loading
  bounded and fail closed, preserve the non-overridable reviewer role/JSON
  contract, and snapshot its content into each immutable review case.

## Change discipline

- Preserve the execution-plane/review-plane split described in
  `docs/architecture.md`.
- Add regression tests for classifier precedence, capability binding, session
  and configuration invalidation, cancellation, worker cleanup, and every new
  reactive authorization path.
- Assert that every permission block omits Pi's `terminate` flag. Hard turn
  termination is outside this extension's permission model; escalation through
  reviewers and the human is the authority path.
- Keep README security claims narrower than the implemented boundary. Update
  README, architecture notes, examples, and future-design notes together when a
  change affects user expectations.
- Before committing, run `npm run check`, `npm run package:check`, and
  `git diff --check`. The macOS runtime is exercised; Linux runtime validation
  remains required before claiming cross-platform readiness.
