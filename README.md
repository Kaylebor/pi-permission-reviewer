# pi-permission-reviewer

A portable, fail-closed Pi permission gate with ordered model-review levels.

The extension combines `pi-perm`'s cross-platform policy with a per-invocation
Sandbox Runtime worker and an isolated, tool-less reviewer chain. It does not
load the `pi-perm` extension separately; it imports the underlying engine so
there is one `tool_call` gate and one bash execution boundary.

> [!IMPORTANT]
> Pi extensions run with the permissions of the Pi process. Model review is
> probabilistic. Keep Sandbox Runtime enabled: the reviewer supplements the
> sandbox and deterministic rules; it does not replace them.

## Status

Early development release. The review-level engine, conservative bash router,
fail-closed model invocation, exact-input locking, and `pi-perm` composition are
implemented. Configuration and adversarial coverage will evolve before an npm
release. The current reactive worker has been exercised on macOS; Linux runtime
validation is still pending and Windows is not currently a supported target.

Tiered model review applies to agent-issued `bash` calls and to `pi-perm`
confirmation decisions for Pi's built-in `read`, `write`, and `edit` tools.
Deterministic `pi-perm` allows and blocks remain authoritative policy outcomes;
arbitrary custom tools, MCP actions, and user-entered `!` commands are not
covered by the reviewer chain. If another extension replaces an effective
`read`, `write`, or `edit` tool, this package blocks that call instead of
approving an executor it does not own.

### Trust boundary

This package mediates Pi tool calls; it is not a sandbox around the Pi process
or around extension code. A model cannot directly invoke Node APIs, but every
loaded Pi extension is trusted code running with Pi's own permissions. An
extension can initiate effects from a tool, command, event handler, timer, or
background job without a new `tool_call` event, using APIs such as
`child_process.spawn()`, filesystem functions, or network clients. A custom
model-facing tool that performs such effects internally is therefore outside
this package's execution boundary after its outer tool call has been allowed.

Treat installed extensions, custom tools, and package update sources as part of
the trusted computing base. Prefer integrations that use Pi's normal tools, or
that deliberately execute through an equivalent sandbox and immutable approval
capability. Do not describe this extension as mediating every effect of the Pi
process.

`pi-subagents` launches a separate child Pi process. Its outer `subagent` call
is visible here only as a non-bash Pi tool; the package's own process launches,
worktree operations, hooks, and other runner internals are extension-side
effects outside this sandbox. With ambient discovery enabled, the child
normally loads this package independently. Its subsequent Pi `bash` calls
receive this gate only if this package owns the child's effective bash tool and
no competing extension override wins that slot. An explicit child `extensions`
allowlist, `defaultExtensions: []`, `--no-extensions`, or an extension-denying
capability ceiling can exclude it. Extension presence or launch acknowledgement
alone does not prove effective executor ownership. Parent and child review
state are never shared.

## Install from GitHub

```sh
pi install git:github.com/Kaylebor/pi-permission-reviewer
```

Anthropic Sandbox Runtime is installed as a package dependency. A separate
global `srt` command is not required. The reactive worker requires `node` on
`PATH` even when Pi itself is a Bun executable; set `PI_PERMISSION_REVIEWER_NODE`
to an explicit Node binary when needed.

## Configure inside Pi

Run:

```text
/permission-reviewer
```

The interactive menu can add and remove reviewers, change same-level fallback
order, configure reviewer context and history persistence, edit the additional
policy, or open the complete JSON in Pi's editor.
Changes are written atomically, use user-only file permissions on Unix, and take
effect in the running Pi session.

Subcommands are available for direct access:

```text
/permission-reviewer status
/permission-reviewer configure
/permission-reviewer models
/permission-reviewer reload
```

`models` uses Pi's current model scope when one is configured with
`enabledModels` or `--models`; otherwise it lists authenticated models from
Pi's registry. Choosing a reviewer never changes the conversation model.

With no configuration, the extension deliberately runs in human-only mode. It
does not assume an OpenAI account, choose a provider, or consume model quota
until reviewers are explicitly configured.

## Configuration file

The UI manages:

```text
~/.pi/agent/permission-reviewer.json
```

You can also edit it directly, copy an example, or point
`PI_PERMISSION_REVIEWER_CONFIG` at another trusted user-level file.
Invalid configuration disables automatic approval and routes reviewable actions
to the human rather than silently weakening policy.
If the underlying permission-engine configuration cannot be parsed or
validated, the extension still installs a fail-closed handler that blocks all
agent tool calls and reports the initialization error.

Runtime audit and generated sandbox files live under
`~/.pi/agent/permission-reviewer`. Set `PI_PERMISSION_REVIEWER_RUNTIME_DIR` to
override that machine-local location. The bundled `audit.jsonl` is pi-perm
policy-stage telemetry, not a complete reviewer authorization or execution
ledger. In particular, a file-tool confirmation decision records the handoff
to review, not its eventual model/human result; do not infer execution from it.

Every model is identified by Pi's own `provider/model` identity. Built-in
providers, custom `models.json` providers, and extension-registered providers
are treated alike. A manually entered model may be unavailable now and become
usable later after its provider is authenticated.

Semantics:

- The command router assigns a minimum level.
- Levels may be sparse and are visited in ascending numeric order.
- Array order breaks ties. Unavailable, failed, or timed-out entries fall
  through to the next tied reviewer; each level accepts at most one assessment.
- `allow` executes the exact, locked tool input.
- `deny` blocks the exact action and returns the reason to the agent as a failed
  tool result. Permission denials never request early turn termination, so the
  agent can explain the restriction, choose another approach, or ask the user.
- `escalate` advances to the next strictly higher level after tied fallbacks
  have served their availability role.
- `human` or exhaustion reaches a human when interactive UI exists; headless
  operation fails closed while still returning the denial to the agent.

`level` expresses permission-review capability, not a provider or benchmark
rank. Level 0 should handle routine decisions cheaply; level 1 should be the
first reviewer trusted with complex shell semantics; higher levels are optional
before human fallback. The user decides which models meet those roles.

## Examples

- [`examples/openai-codex.json`](examples/openai-codex.json) uses Luna for
  routine checks and Terra for complex ones.
- [`examples/mixed-providers.json`](examples/mixed-providers.json) shows a
  low-cost provider at level 0, a different provider at level 1, and an
  optional stronger level 2.
- [`examples/same-level-fallbacks.json`](examples/same-level-fallbacks.json)
  shows provider failover without invoking two models at the same level.

Names outside Pi's built-in catalogue are illustrative. Replace them with the
exact identifiers shown by `/permission-reviewer models` after configuring the
provider in Pi. For example, a custom Ollama-compatible endpoint can be added
through Pi's `~/.pi/agent/models.json`, then selected exactly like a native
provider model.

Reviewers have no tools. By default they receive the immutable permission case
plus a bounded, redacted transcript derived from Pi's public `context` and
`message_end` events. System prompts, thinking, image data, provider diagnostics,
and opaque message details are excluded. Conversation and tool evidence have
separate defaults of 4,000 and 2,000 approximate tokens. Set `reviewContext.mode`
to `metadata` to share only aggregate counts, or adjust both budgets in the UI.
Redaction recognizes structured sensitive keys and common credential patterns;
it is defense in depth, not a guarantee that arbitrary secret text is detected.

`reviewContext.persistence` defaults to `command`: the original assessment and
reactive follow-up share a local message history which is destroyed when the
command ends. Optional `session` persistence keeps a bounded local trunk per
reviewer model for the Pi session. Session-trunk calls are serialized and all
histories are cleared on session boundaries and configuration reload. These are
provider-neutral local histories; the extension does not require a provider-side
conversation API. Future constrained read-only inspection should be added as an
explicit capability rather than exposing shell access.

Reactive continuation defaults to `reactiveReview.reasoning: "one-lower"` with
a `low` floor. Only the original reviewer that allowed the command is reduced:
for example, `medium` becomes `low`, `xhigh` becomes `high`, and `max` becomes
`xhigh`. A reviewer
already configured below the floor is not raised. Same-level fallbacks and all
higher-level escalations use their normal configured reasoning. Set the strategy
to `inherit`, `minimum`, or an explicit Pi reasoning level to change this. The
resumed winner also reuses the original evidence already in its local history
instead of sending a duplicate copy; a newly reached reviewer receives the full
bounded evidence packet.

## Current routing policy

- Known read-only commands skip model review but still run under the sandbox,
  unless they contain a pipe or redirection.
- Uncategorized simple commands start at level 0.
- Complex shell syntax starts at level 1.
- Privileged, publishing, infrastructure, and external Git writes go directly
  to the human.
- Every pipe or redirection goes to level 1 review after deterministic deny
  rules, even when the base command is normally skipped or human-routed.
- Recognized credential paths, remote content piped into a shell interpreter,
  and severe system actions are blocked deterministically.
- A `pi-perm` confirmation for built-in `read` starts at level 0. Confirmed
  built-in `write` and `edit` operations start at level 1. Their allowed exact
  input is locked before Pi's built-in executor runs.

These rules are intentionally conservative and are not a shell security parser.
Obfuscated shell spellings may bypass literal deterministic matches, but shell
metacharacters still route the action to level 1 review. The OS sandbox remains
the security boundary; do not grant reviewers access to secrets or unrestricted
egress on the assumption that command classification is complete.
Deterministic `pi-perm` blocks are authoritative and cannot be overturned by a
reviewer; only `pi-perm` confirmation decisions enter the model chain. A
reviewer approval of a file operation does not add a persistent `pi-perm`
allow: it authorizes only that locked Pi tool call.

## Reactive network review

An approved command remains inside Sandbox Runtime. If it attempts a connection
outside the configured network allowlist, SRT pauses the original process before
connecting and reports the concrete host and port. The extension first resumes
the local reviewer history of the model that allowed the command, adding the
destination as a continuation. An escalation can then visit each strictly
higher configured level; unavailable, failed, and timed-out models use
same-level fallbacks in array order. If the chain cannot decide—or the command
was approved by a human—the human receives a second, explicit destination
prompt. Every invocation remains a fresh provider completion; continuity comes
from locally supplied messages.

Allowing the destination resumes the same process; the command is not rerun.
The decision is bound to the exact Pi tool-call ID and cached only for that
host-port pair for the lifetime of that command. Explicit SRT deny rules remain
authoritative and never reach the reviewer. Headless operation denies off-list
connections. Reviews are serialized, limited to eight distinct destinations per
command, and cancelled after 30 seconds or when the command ends. Reactive
approval is currently limited to public-looking HTTPS destinations on port 443;
loopback, local/private literal addresses, metadata
hosts, and other ports fail closed. DNS rebinding cannot be ruled out from
SRT's hostname-only callback, so host approval should not be treated as content-
or credential-aware authorization.

The Pi bash `timeout` counts active sandboxed execution and pauses while a
network permission decision is pending. Timeouts implemented by the command
itself do not pause: for example, `curl --max-time 10` can expire while a model
or human reviews a redirect destination. Agents are prompted to omit short
application-level wall-clock deadlines or leave enough review headroom when a
command may contact new hosts.

The worker receives a deliberately reduced environment and adds OS-level read
denials for common SSH, cloud, container, package-manager, Git credential, Pi,
Codex, and macOS Keychain paths. These are defense-in-depth controls, not a
complete secret detector.

This first reactive bridge covers network destinations. Reactive filesystem,
Unix-socket, and local-binding grants are not implemented yet. A curated and
user-expandable catalogue of common host-port combinations is intentionally
deferred until the reactive review path is established.

## Relationship to existing packages

- [`pi-perm`](https://github.com/DCRcoder/pi-perm) supplies reusable permission
  evaluation and effective-profile translation. This extension replaces its
  CLI spawn hook with a per-invocation Sandbox Runtime library worker so an
  off-list connection can be reviewed without restarting the command. Version
  0.1.8 exposes no documented stable embedder contract, so the private adapter
  is pinned, shape-validated, and deliberately isolated.
- [`pi-approval-guardian`](https://github.com/mics8128/pi-approval-guardian)
  informed the fail-closed reviewer and exact-input locking design. It is not a
  runtime dependency because loading two independent approval extensions would
  create ambiguous interception order, and its current peer range targets an
  older Pi release.

See `THIRD_PARTY_NOTICES.md` for attribution.
Ideas for safe inter-extension composition are recorded separately in
[`docs/future-extension-integration.md`](docs/future-extension-integration.md);
they are not current guarantees.

## Development

Requires Node.js 22.19 or newer.

```sh
npm install
npm run check
npm run package:check
```

For a local Pi run:

```sh
pi -e .
```
