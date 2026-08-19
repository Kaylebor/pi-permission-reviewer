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

Private beta. The current macOS path is exercised in local use, including the
reactive network worker, Git fsmonitor compatibility, SSH-agent access, and SSH
commit signing. Linux receives the same type, unit, and package checks in CI,
but its real Sandbox Runtime path remains provisional until it is exercised on
a Linux host. Windows is not currently a supported target.

| Platform | Automated checks | Live runtime status |
| --- | --- | --- |
| macOS | Type, unit, package, and local-only SRT integration checks | Exercised |
| Linux | Type, unit, package, and local-only SRT integration checks | Provisional pending user-host validation |
| Windows | None | Unsupported |

Tiered model review applies to agent-issued `bash` calls and to `pi-perm`
confirmation decisions for Pi's built-in `read`, `write`, and `edit` tools.
Deterministic `pi-perm` allows and blocks remain authoritative policy outcomes;
arbitrary custom tools, MCP actions, and user-entered `!` commands are not
covered by the reviewer chain. If another extension replaces an effective
`read`, `write`, or `edit` tool, this package blocks that call instead of
approving an executor it does not own.

At session start and in `/permission-reviewer status`, runtime health reports
whether this package owns Pi's effective `bash` tool and whether the effective
file tools are Pi built-ins. A competing Bash registration produces a prominent
warning: review hooks may still run, but this package cannot guarantee that its
capability-consuming sandbox executor will receive the approved call.

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

With the default ambient extension discovery and no child-specific extension
changes, loading this package again in the child is the expected behavior. If a
launcher supplies an explicit extension list, include this package explicitly
to retain checks. Omitting it is a supported way to disable this gate for that
child, but should be treated as a conscious trust-boundary change.

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
order, configure reviewer context, sandbox concurrency, reactive review, and Git boundary
compatibility, edit the additional policy or Guardian prompt, or open the
complete JSON in Pi's editor.
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

The built-in Guardian prompt treats bounded, task-relevant, read-only context
gathering as implicit authorization. Reviewers should therefore allow ordinary
reads of relevant repository files, project instructions, installed skill
definitions, and documentation without requiring the user to name each file.
This does not extend to credentials, secrets, broad home-directory discovery,
unrelated personal data, writes, execution, or network access.

Set `guardianPromptFile` to a trusted Markdown file to add local authorization
guidance to the reviewer system prompt. Relative paths resolve beside the JSON
configuration; absolute paths and `~/...` are also supported. The configuration
menu's **Edit Guardian prompt** action uses
`~/.pi/agent/permission-reviewer.guardian.md` by default. The file is limited to
32 KiB, loaded at startup, `/permission-reviewer reload`, or any successful
configuration save, and snapshotted into each immutable permission case so
reactive review uses the same guidance.
A configured file that is missing, unreadable, not a regular `.md` file, or too
large disables automatic approval and falls back to the human. Its contents are
sent to every configured reviewer as trusted system guidance, so keep secrets
and provider-specific credentials out of it.

```json
{
  "guardianPromptFile": "permission-reviewer.guardian.md"
}
```

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

`boundaryReview` controls a narrow public-key-read capability and two Git
preflight compatibility requests. All fields are optional when editing JSON;
omitted fields use these safe defaults:

```json
{
  "boundaryReview": {
    "publicKeyRead": "review",
    "gitFsmonitor": true,
    "gitSshAgent": "review"
  }
}
```

- `publicKeyRead` is either `"review"` (the default) or `"block"`. `review`
  routes an explicit public-key-read capability request through the reviewer
  chain; `block` denies it deterministically. It does not permit arbitrary
  filesystem reads.
- `gitFsmonitor` enables Git fsmonitor compatibility. macOS adds only the
  repository's resolved socket path; Linux disables fsmonitor through an
  invocation-local Git config overlay. It never changes user Git config.
- `gitSshAgent` is either `"review"` (the default) or `"block"`. `block`
  makes Git SSH-agent access a deterministic denial; `review` routes it through
  the reviewer path at level 1 or higher.

These settings never weaken an explicit Sandbox Runtime or `pi-perm` deny.
Deterministic classification and policy take precedence. The approved Linux
SSH-agent path disables AF_UNIX isolation for that one invocation because SRT
cannot filter Unix sockets by pathname there. Docker, Podman, and other local
service sockets may then permit control beyond the remaining sandbox.

`execution.maxConcurrentSandboxes` defaults to `4` and accepts `1` through
`32`. Calls beyond the active limit wait in a cancellable FIFO instead of
failing. Session changes, configuration reloads, shutdown, and caller
cancellation remove queued work; increasing the limit drains the queue.

Semantics:

- Commands with proactive or concrete boundary requests receive a minimum
  review level; commands with no matching rule run contained without a model.
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
- [`examples/guardian-prompt.md`](examples/guardian-prompt.md) is a small
  portable starting point for `guardianPromptFile`; the Pi configuration UI can
  create and edit the active file directly.

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
a `low` floor. The latest reviewer that successfully allowed the command or a
reactive continuation becomes the next continuation anchor. Only that resumed
reviewer is reduced:
for example, `medium` becomes `low`, `xhigh` becomes `high`, and `max` becomes
`xhigh`. A reviewer
already configured below the floor is not raised. Same-level fallbacks and all
higher-level escalations use their normal configured reasoning. Set the strategy
to `inherit`, `minimum`, or an explicit Pi reasoning level to change this. The
resumed winner also reuses the original evidence already in its local history
instead of sending a duplicate copy; a newly reached reviewer receives the full
bounded evidence packet.

`reactiveReview.inspection` defaults to `"destination"`. The opt-in
`"http-metadata"` mode additionally enables SRT's experimental TLS termination
and request filter for HTTPS requests to destinations that this extension
approved reactively. Configure it through `/permission-reviewer configure` or
JSON:

```json
{
  "reactiveReview": {
    "reasoning": "one-lower",
    "floor": "low",
    "inspection": "http-metadata",
    "incompleteBodyApproval": "human",
    "requestIdentityIgnoredHeaders": []
  }
}
```

## Current routing policy

- Known read-only commands skip model review but still run under the sandbox,
  unless they contain a pipe or redirection.
- Uncategorized simple commands start at level 0.
- Complex shell syntax starts at level 1.
- Privileged, publishing, infrastructure, and external Git writes enter level-1
  agentic review and fall back to the human when the reviewer chain cannot
  decide.
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

## Explicit Bash permissions

When this package owns the effective active `bash` tool, it appends stable
permission guidance to Pi's assembled system prompt through
`before_agent_start`. This works even when a custom `SYSTEM.md` replaces Pi's
default prompt and does not require users to edit `SYSTEM.md`,
`APPEND_SYSTEM.md`, or `AGENTS.md`. The guidance describes the structured
permission fields, minimum-access retry shape, automatic Git/network handling,
and the fact that every authorization is a one-use per-call capability rather
than a persistent policy change. Enforcement remains independent of this
advisory prompt.

The registered `bash` tool accepts an optional structured permission request:

```json
{
  "command": "tool --input /outside/input --output /outside/result",
  "permissions": {
    "read": ["/outside/input"],
    "publicKeyRead": ["/home/alice/.ssh/signing.pub"],
    "write": ["/outside/result"],
    "unixSockets": ["/run/example.sock"],
    "sshAgent": true,
    "sshDestination": { "host": "github.com", "port": 22 }
  }
}
```

Each path must be normalized, absolute, glob-free, no list may contain more
than 16 paths, and the complete permission object is capped at 4,096
characters. `sshDestination` is an exact SSH host and port (defaulting to 22),
and materializes as a one-invocation SRT network allow entry. `publicKeyRead` is an explicit semantic exception to the blanket
`~/.ssh` read deny: each exact `.pub` path must be a small, regular,
non-symlink, owner-controlled, non-writable SSH public-key file. A more-specific
configured deny for that file remains authoritative, and the file is
revalidated immediately before execution. A request is shown in full before
any possibly truncated command input in the human prompt, and is bound into the
one-use capability. Read-only
requests enter at level 0; write, Unix-socket, and SSH-agent requests enter at
level 1. Apart from the validated public-key exception above, `pi-perm`,
classifier, and hardened SRT denies remain authoritative, so a reviewer cannot
re-allow an explicitly denied path or socket.

The default remains contained execution with no extra access. If a contained
attempt fails, the agent may resubmit the unchanged command with the minimum
explicit permissions, but this extension never retries a failed command. That
avoids duplicating partial effects.

On macOS, each requested Unix-socket pathname grants SRT's bundled bind/connect
access to that pathname. On Linux, SRT disables AF_UNIX isolation for any
`unixSockets` or `sshAgent` request. That exposes Docker, Podman, and other local
service sockets and can permit control beyond the remaining sandbox, so this
consequence is included in the review prompt. `sshAgent` also exposes only the
current `SSH_AUTH_SOCK` value; the rest of the child environment stays
sanitized. Local TCP binding is unsupported.

## Git preflight compatibility

Every command starts with frozen contained Sandbox Runtime settings. Recognized
Git operations may request only the configured preflight compatibility paths:
`gitFsmonitor` provides the platform-specific fsmonitor handling without
changing user Git configuration, and `gitSshAgent` either blocks or routes a
Git SSH-agent request through the reviewer chain. Recognized SSH `push`, `fetch`,
and `pull` operations also derive the exact remote host and port as a
preflight network capability; this is not a persistent domain whitelist.
They also derive exact reads for existing owner-controlled default
`~/.ssh/known_hosts` and `known_hosts2` files. These files are validated from
metadata only, revalidated immediately before execution, and never inspected
by the extension; a more-specific deny remains authoritative.
Local binding remains blocked.
For SSH-signed commits and tags, Git detection also derives the same generic
`public-key-read` capability from `user.signingKey`; it never grants a private
key path. Git detection is a convenience producer over the same frozen
per-invocation boundary. Other commands request that generic capability through
the explicit `permissions` object rather than reusing Git-specific controls.

`publicKeyRead` controls the generic public-key-read capability separately from
Git detection. Its `review` mode routes an explicit request through the
reviewer chain; `block` is authoritative. It remains a scoped preflight
capability, not a general filesystem-read exception.

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
host-port pair for the lifetime of that command. In the default `destination`
mode, an allow therefore authorizes any traffic the process sends over that
destination channel; the extension cannot distinguish HTTP methods, paths,
headers, bodies, credentials, or a changed DNS resolution. Reviewer and
main-agent prompts state this explicitly so the decision is made at the actual
available granularity. Explicit SRT deny rules remain
authoritative and never reach the reviewer. Headless operation denies off-list
connections. Reviews are serialized and cancelled after 30 seconds or when the
command ends. Completed destination decisions use an eight-entry LRU cache;
evicted destinations are reviewed again rather than stopping the command. A
fixed 64-review in-flight safety ceiling rejects only pathological concurrent
request floods with a continuable per-request denial. Reactive
approval is currently limited to public-looking HTTPS destinations on port 443;
loopback, local/private literal addresses, metadata
hosts, and other ports fail closed. DNS rebinding cannot be ruled out from
SRT's hostname-only callback, so host approval should not be treated as content-
or credential-aware authorization.

The opt-in `http-metadata` mode adds a second pause before each parsed HTTP
request to a reactively approved destination. The reviewer receives only the
method, origin, a constrained route shape, categorized query/header names,
content type/declared size, and bounded body characteristics.
Header values, query values, and raw body bytes never leave the worker. Body
inspection is capped at 64 KiB and 1.5 seconds; complete bodies contribute a
SHA-256 digest and heuristic risk flags, while incomplete inspection is marked
and never cached. This includes declared GET, HEAD, or OPTIONS bodies, whose
bytes SRT cannot expose through its Fetch-compatible callback. By default the
reviewer supplies advice but only a human can approve the unseen bytes once;
set `incompleteBodyApproval` to `"reviewer"` to let the configured ladder decide.

Cache identity is an opaque command-local HMAC over the exact URL, protected
headers, and a complete body digest; it is used only by the transport and is not
sent to the reviewer. Strictly formatted trace/request identifiers are
normalized. `requestIdentityIgnoredHeaders` can explicitly exclude up to 32
additional non-sensitive headers, but rejects credentials, authority, and HTTP
framing fields. Completed request decisions use a 16-entry LRU cache; an evicted
shape is reviewed again. Different protected values or request shapes still
require another review.

This mode is experimental because it relies on SRT TLS termination. It can
break certificate-pinned or mutual-TLS clients and rejects configurations with
TLS-termination exclusions rather than silently creating an inspection gap.
Statically allowlisted domains retain their configured policy and do not enter
request review. Non-HTTP traffic, opaque proxy paths, response content, and DNS
resolution are not inspected; the preceding host-port approval is still a
meaningful channel grant, so request metadata is additional evidence rather
than DLP or a complete egress boundary.

The Pi bash `timeout` counts active sandboxed execution and pauses during HTTP
body inspection as well as network or request permission review. Timeouts implemented by the command
itself do not pause: for example, `curl --max-time 10` can expire while a model
or human reviews a redirect destination. Agents are prompted to omit short
application-level wall-clock deadlines or leave enough review headroom when a
command may contact new hosts.

The worker receives a deliberately reduced environment and adds OS-level read
denials for common SSH, cloud, container, package-manager, Git credential, Pi,
Codex, and macOS Keychain paths. These are defense-in-depth controls, not a
complete secret detector.

The reactive network bridge covers only public-looking HTTPS destinations and
is reviewer-assisted egress control, not DLP. Optional HTTP metadata inspection
improves request-level evidence for traffic SRT can parse, but does not remove
the destination-level limitations above.
SRT pauses the command's actual request; this extension does not issue a safety
probe or duplicate request. DNS resolution and TLS setup may occur first, but
HTTP request contents are forwarded upstream only after approval.
Filesystem and Unix-socket access is preflight-only through the explicit Bash
request above; there is no post-failure discovery or automatic replay. A curated
and user-expandable catalogue of common host-port combinations is intentionally
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

## Dependency watchlist

Dependabot checks the pinned Pi runtime, `pi-perm`, Sandbox Runtime, and GitHub
Actions dependencies. Pi packages are grouped separately from the sandbox
boundary so each update can receive the compatibility or security review its
role requires. CI runs the type, unit, and package checks on macOS and Linux;
this Linux job is portability coverage, not yet evidence of a live Linux SRT
execution path.

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
