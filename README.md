# pi-permission-reviewer

A portable, fail-closed Pi permission gate with ordered model-review levels.

The extension combines `pi-perm`'s cross-platform policy and Sandbox Runtime
integration with an isolated, tool-less reviewer chain. It does not load the
`pi-perm` extension separately; it imports the underlying engine so there is one
`tool_call` gate and one bash wrapper.

> [!IMPORTANT]
> Pi extensions run with the permissions of the Pi process. Model review is
> probabilistic. Keep Sandbox Runtime enabled: the reviewer supplements the
> sandbox and deterministic rules; it does not replace them.

## Status

Early development release. The review-level engine, conservative bash router,
fail-closed model invocation, exact-input locking, and `pi-perm` composition are
implemented. Configuration and adversarial coverage will evolve before an npm
release.

Tiered model review currently applies to agent-issued `bash` calls. File tools
remain under `pi-perm`'s deterministic boundary and human confirmation flow;
arbitrary custom tools, MCP actions, and user-entered `!` commands are not
covered by the reviewer chain.

## Install from GitHub

```sh
pi install git:github.com/Kaylebor/pi-permission-reviewer
```

Install Anthropic Sandbox Runtime separately so `pi-perm` can wrap bash:

```sh
npm install -g @anthropic-ai/sandbox-runtime
```

## Reviewer configuration

Copy `config.example.json` to:

```text
~/.pi/agent/permission-reviewer.json
```

or point `PI_PERMISSION_REVIEWER_CONFIG` at another trusted user-level file.
Invalid configuration disables automatic approval and routes reviewable actions
to the human rather than silently weakening policy.
If the underlying permission-engine configuration cannot be parsed or
validated, the extension still installs a fail-closed handler that blocks all
agent tool calls and reports the initialization error.

Runtime audit and generated sandbox files live under
`~/.pi/agent/permission-reviewer`. Set `PI_PERMISSION_REVIEWER_RUNTIME_DIR` to
override that machine-local location.

```json
{
  "reviewers": [
    { "level": 0, "model": "openai-codex/gpt-5.6-luna" },
    { "level": 0, "model": "another-provider/fast-fallback" },
    { "level": 1, "model": "openai-codex/gpt-5.6-terra" },
    { "level": 2, "model": "another-provider/expert" }
  ]
}
```

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

## Relationship to existing packages

- [`pi-perm`](https://github.com/DCRcoder/pi-perm) supplies reusable permission
  evaluation and cross-platform Sandbox Runtime wrapping.
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
