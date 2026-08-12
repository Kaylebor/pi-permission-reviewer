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

Tiered model review currently applies to agent-issued `bash` calls. File tools
remain under `pi-perm`'s deterministic boundary and human confirmation flow;
arbitrary custom tools, MCP actions, and user-entered `!` commands are not
covered by the reviewer chain.

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
order, edit the additional policy, or open the complete JSON in Pi's editor.
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
override that machine-local location.

Every model is identified by Pi's own `provider/model` identity. Built-in
providers, custom `models.json` providers, and extension-registered providers
are treated alike. A manually entered model may be unavailable now and become
usable later after its provider is authenticated.

Semantics:

- The command router assigns a minimum level.
- Levels may be sparse and are visited in ascending numeric order.
- Array order breaks ties. Unavailable entries are skipped during selection,
  but at most one ready reviewer is invoked per level.
- `allow` executes the exact, locked tool input.
- `deny` blocks immediately.
- `escalate`, unavailable models, failures, and timeouts advance to the next
  strictly higher level.
- `human` or exhaustion reaches a human when interactive UI exists; headless
  operation fails closed.

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

Reviewers have no tools. They receive an immutable evidence packet containing
the tool input, working directory, classifier reason, policy, and latest direct
user input. Future constrained read-only inspection should be added as an
explicit capability rather than exposing shell access.

## Current routing policy

- Known read-only commands skip model review but still run under the sandbox.
- Uncategorized simple commands start at level 0.
- Complex shell syntax starts at level 1.
- Privileged, publishing, infrastructure, and external Git writes go directly
  to the human.
- Recognized credential paths, literal `curl`/`wget` pipelines, and severe
  system actions are blocked deterministically.

These rules are intentionally conservative and are not a shell security parser.
Obfuscated shell spellings may bypass literal deterministic matches, but shell
metacharacters still route the action to level 1 review. The OS sandbox remains
the security boundary; do not grant reviewers access to secrets or unrestricted
egress on the assumption that command classification is complete.
Deterministic `pi-perm` blocks are terminal and cannot be overturned by a
reviewer; only operations classified for confirmation enter the model chain.

## Reactive network review

An approved command remains inside Sandbox Runtime. If it attempts a connection
outside the configured network allowlist, SRT pauses the original process before
connecting and reports the concrete host and port. The extension then asks the
same configured model reviewer once more using an immutable copy of the original
request, its prior assessment, and the new destination. This is a fresh model
completion with continuation context, not a provider-side chat session. If that
reviewer cannot decide—or the command was approved by a human—the human receives
a second, explicit destination prompt.

Allowing the destination resumes the same process; the command is not rerun.
The decision is bound to the exact Pi tool-call ID and cached only for that
host-port pair for the lifetime of that command. Explicit SRT deny rules remain
terminal and never reach the reviewer. Headless operation denies off-list
connections. Reviews are serialized, limited to eight distinct destinations per
command, and cancelled after 30 seconds or when the command ends. Reactive
approval is currently limited to public-looking HTTPS destinations on port 443;
loopback, local/private literal addresses, metadata
hosts, and other ports fail closed. DNS rebinding cannot be ruled out from
SRT's hostname-only callback, so host approval should not be treated as content-
or credential-aware authorization.

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
  off-list connection can be reviewed without restarting the command.
- [`pi-approval-guardian`](https://github.com/mics8128/pi-approval-guardian)
  informed the fail-closed reviewer and exact-input locking design. It is not a
  runtime dependency because loading two independent approval extensions would
  create ambiguous interception order, and its current peer range targets an
  older Pi release.

See `THIRD_PARTY_NOTICES.md` for attribution.

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
