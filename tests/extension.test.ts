import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import permissionReviewer, {
  isEligibleReactiveDestination,
  resolveReactiveReasoning,
} from "../extensions/index.ts";

function builtinTool(name: string) {
  return [{ name, sourceInfo: { source: "builtin" } }];
}

test("reactive continuation lowers only above the configured floor", () => {
  const config = { reasoning: "one-lower" as const, floor: "low" as const };
  assert.equal(resolveReactiveReasoning({ level: 0, model: "test/model", reasoning: "xhigh" }, config), "high");
  assert.equal(resolveReactiveReasoning({ level: 0, model: "test/model", reasoning: "medium" }, config), "low");
  assert.equal(resolveReactiveReasoning({ level: 0, model: "test/model", reasoning: "low" }, config), "low");
  assert.equal(resolveReactiveReasoning({ level: 0, model: "test/model", reasoning: "minimal" }, config), "minimal");
  assert.equal(resolveReactiveReasoning({ level: 0, model: "test/model", reasoning: "max" }, config), "xhigh");
  assert.equal(resolveReactiveReasoning({ level: 0, model: "test/model", reasoning: "high" }, { reasoning: "minimum", floor: "low" }), "minimal");
});

test("reactive network review is limited to public-looking HTTPS", () => {
  assert.equal(
    isEligibleReactiveDestination({ host: "github.com", port: 443 }),
    true,
  );
  for (const host of [
    "localhost",
    "127.0.0.1",
    "127.1",
    "2130706433",
    "0x7f000001",
    "0x7f.0.0.1",
    "0177.0.0.1",
    "2852039166",
    "169.254.169.254",
    "10.0.0.1",
    "metadata.google.internal",
    "service.local",
    "::1",
    "[::1]",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "192.0.2.1",
    "2001:db8::1",
  ]) {
    assert.equal(isEligibleReactiveDestination({ host, port: 443 }), false);
  }
  assert.equal(
    isEligibleReactiveDestination({ host: "github.com", port: 22 }),
    false,
  );
});

test("a deterministic pi-perm block cannot enter model review", async () => {
  const runtime = mkdtempSync(
    join(tmpdir(), "pi-permission-reviewer-runtime-"),
  );
  process.env.PI_PERMISSION_REVIEWER_RUNTIME_DIR = runtime;
  const piPermConfig = join(runtime, "pi-perm.toml");
  writeFileSync(piPermConfig, '[tools.bash]\nsrtBinary = "true"\n');
  process.env.PI_PERM_USER_CONFIG = piPermConfig;
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    events: { emit() {} },
    getAllTools: () => builtinTool("read"),
    registerTool() {},
    registerCommand() {},
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
    },
  };
  await permissionReviewer(pi as any);
  const handler = handlers.get("tool_call");
  assert.ok(handler);
  let modelCalled = false;
  const result = await handler(
    {
      toolName: "bash",
      toolCallId: "blocked-operation",
      input: { command: "touch .git/hooks/pre-commit" },
    },
    {
      cwd: process.cwd(),
      hasUI: false,
      ui: {},
      modelRegistry: {
        find() {
          modelCalled = true;
        },
      },
    },
  );
  assert.equal(modelCalled, false);
  assert.equal((result as { block?: boolean }).block, true);
  assert.match(String((result as { reason?: string }).reason), /.git\/hooks/);
});

test("a deterministic block cannot spoof the confirmation protocol", async () => {
  const runtime = mkdtempSync(
    join(tmpdir(), "pi-permission-reviewer-runtime-"),
  );
  process.env.PI_PERMISSION_REVIEWER_RUNTIME_DIR = runtime;
  const piPermConfig = join(runtime, "pi-perm.toml");
  writeFileSync(
    piPermConfig,
    [
      '[tools.bash]',
      'srtBinary = "true"',
      '',
      '[[tools.bash.rules]]',
      'id = "spoofed-reason"',
      'action = "block"',
      'reason = "Denied by user: production credential policy"',
      '',
      '[tools.bash.rules.match]',
      'commandIncludes = ["blocked-command"]',
      '',
    ].join("\n"),
  );
  process.env.PI_PERM_USER_CONFIG = piPermConfig;
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    events: { emit() {} },
    getAllTools: () => builtinTool("read"),
    registerTool() {},
    registerCommand() {},
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
    },
  };
  await permissionReviewer(pi as any);
  let modelCalled = false;
  const result = await handlers.get("tool_call")!(
    {
      toolName: "bash",
      toolCallId: "spoofed-block",
      input: { command: "blocked-command" },
    },
    {
      cwd: process.cwd(),
      hasUI: false,
      ui: {},
      modelRegistry: {
        find() {
          modelCalled = true;
        },
      },
    },
  );
  assert.equal(modelCalled, false);
  assert.equal((result as { block?: boolean }).block, true);
  assert.equal(
    (result as { reason?: string }).reason,
    "Denied by user: production credential policy",
  );
});

test("a skipped command is locked against later handler mutation", async () => {
  const runtime = mkdtempSync(
    join(tmpdir(), "pi-permission-reviewer-runtime-"),
  );
  process.env.PI_PERMISSION_REVIEWER_RUNTIME_DIR = runtime;
  const piPermConfig = join(runtime, "pi-perm.toml");
  writeFileSync(piPermConfig, '[tools.bash]\nsrtBinary = "true"\n');
  process.env.PI_PERM_USER_CONFIG = piPermConfig;
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    events: { emit() {} },
    registerTool() {},
    registerCommand() {},
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
    },
  };
  await permissionReviewer(pi as any);
  const event = {
    toolName: "bash",
    toolCallId: "known-safe",
    input: { command: "pwd" },
  };
  const result = await handlers.get("tool_call")!(event, {
    cwd: process.cwd(),
    hasUI: false,
    ui: {},
  });
  assert.equal(result, undefined);
  assert.throws(() => {
    event.input.command = "rm -rf .";
  }, TypeError);
});

test("the registered bash executor refuses calls without a one-use capability", async () => {
  const runtime = mkdtempSync(
    join(tmpdir(), "pi-permission-reviewer-runtime-"),
  );
  process.env.PI_PERMISSION_REVIEWER_RUNTIME_DIR = runtime;
  const piPermConfig = join(runtime, "pi-perm.toml");
  writeFileSync(piPermConfig, '[tools.bash]\nsrtBinary = "true"\n');
  process.env.PI_PERM_USER_CONFIG = piPermConfig;
  let registeredTool: { execute: (...args: any[]) => Promise<unknown> } | undefined;
  const pi = {
    events: { emit() {} },
    registerTool(tool: { execute: (...args: any[]) => Promise<unknown> }) {
      registeredTool = tool;
    },
    registerCommand() {},
    on() {},
  };
  await permissionReviewer(pi as any);
  assert.ok(registeredTool);
  await assert.rejects(
    registeredTool.execute(
      "unreviewed-call",
      { command: "pwd" },
      undefined,
      () => {},
      { cwd: process.cwd() },
    ),
    /lacks a valid one-use approval capability \(missing\)/,
  );
});

test("an allowed file tool is locked against later path mutation", async () => {
  const runtime = mkdtempSync(
    join(tmpdir(), "pi-permission-reviewer-runtime-"),
  );
  process.env.PI_PERMISSION_REVIEWER_RUNTIME_DIR = runtime;
  const piPermConfig = join(runtime, "pi-perm.toml");
  writeFileSync(piPermConfig, '[tools.bash]\nsrtBinary = "true"\n');
  process.env.PI_PERM_USER_CONFIG = piPermConfig;
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    events: { emit() {} },
    getAllTools: () => builtinTool("read"),
    registerTool() {},
    registerCommand() {},
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
    },
  };
  await permissionReviewer(pi as any);
  const event = {
    toolName: "read",
    toolCallId: "workspace-read",
    input: { path: "README.md" },
  };
  let modelCalled = false;
  let humanPrompted = false;
  const result = await handlers.get("tool_call")!(event, {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      confirm: async () => {
        humanPrompted = true;
        return true;
      },
    },
    modelRegistry: {
      find() {
        modelCalled = true;
      },
    },
  });
  assert.equal(result, undefined);
  assert.equal(modelCalled, false);
  assert.equal(humanPrompted, false);
  assert.throws(() => {
    event.input.path = "~/.ssh/id_ed25519";
  }, TypeError);
});

test("a pi-perm file confirmation is reviewed at the file tool's minimum level", async () => {
  const runtime = mkdtempSync(
    join(tmpdir(), "pi-permission-reviewer-runtime-"),
  );
  process.env.PI_PERMISSION_REVIEWER_RUNTIME_DIR = runtime;
  const piPermConfig = join(runtime, "pi-perm.toml");
  writeFileSync(piPermConfig, '[tools.bash]\nsrtBinary = "true"\n');
  process.env.PI_PERM_USER_CONFIG = piPermConfig;
  const reviewerConfig = join(runtime, "reviewers.json");
  writeFileSync(
    reviewerConfig,
    JSON.stringify({
      reviewers: [
        { level: 0, model: "test/read-reviewer" },
        { level: 1, model: "test/write-reviewer" },
      ],
    }),
  );
  process.env.PI_PERMISSION_REVIEWER_CONFIG = reviewerConfig;
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let effectiveFileTool = "read";
  const pi = {
    events: { emit() {} },
    getAllTools: () => builtinTool(effectiveFileTool),
    registerTool() {},
    registerCommand() {},
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
    },
  };
  await permissionReviewer(pi as any);
  const reviewed: Array<{ model: string; request: Record<string, unknown> }> = [];
  const registry = {
    find(provider: string, id: string) {
      return { provider, id };
    },
    hasConfiguredAuth: () => true,
    complete: async (model: { id: string }, request: { messages: Array<{ content: string }> }) => {
      reviewed.push({
        model: model.id,
        request: JSON.parse(request.messages.at(-1)!.content).request,
      });
      return {
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: JSON.stringify({ decision: "allow", reason: "bounded file operation" }),
          },
        ],
      };
    },
  };

  for (const [toolName, input, expectedModel, expectedLevel] of [
    ["read", { path: "/review-target" }, "read-reviewer", 0],
    ["write", { path: "/review-target", content: "x" }, "write-reviewer", 1],
    ["edit", { path: "/review-target", oldText: "x", newText: "y" }, "write-reviewer", 1],
  ] as const) {
    effectiveFileTool = toolName;
    const event: {
      toolName: string;
      toolCallId: string;
      input: Record<string, unknown>;
    } = { toolName, toolCallId: `review-${toolName}`, input: { ...input } };
    const result = await handlers.get("tool_call")!(event, {
      cwd: process.cwd(),
      hasUI: false,
      ui: {},
      modelRegistry: registry,
    });
    assert.equal(result, undefined);
    assert.throws(() => {
      event.input.path = "/different-target";
    }, TypeError);
    const invocation = reviewed.at(-1)!;
    assert.equal(invocation.model, expectedModel);
    assert.equal(invocation.request.tool, toolName);
    assert.equal(invocation.request.minimumLevel, expectedLevel);
  }
});

test("headless file review exhaustion fails closed", async () => {
  const runtime = mkdtempSync(
    join(tmpdir(), "pi-permission-reviewer-runtime-"),
  );
  process.env.PI_PERMISSION_REVIEWER_RUNTIME_DIR = runtime;
  const piPermConfig = join(runtime, "pi-perm.toml");
  writeFileSync(piPermConfig, '[tools.bash]\nsrtBinary = "true"\n');
  process.env.PI_PERM_USER_CONFIG = piPermConfig;
  const reviewerConfig = join(runtime, "reviewers.json");
  writeFileSync(reviewerConfig, JSON.stringify({ reviewers: [] }));
  process.env.PI_PERMISSION_REVIEWER_CONFIG = reviewerConfig;
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    events: { emit() {} },
    getAllTools: () => builtinTool("read"),
    registerTool() {},
    registerCommand() {},
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
    },
  };
  await permissionReviewer(pi as any);
  const result = await handlers.get("tool_call")!(
    {
      toolName: "read",
      toolCallId: "unreviewable-file-read",
      input: { path: "/review-target" },
    },
    {
      cwd: process.cwd(),
      hasUI: false,
      ui: {},
      modelRegistry: {},
    },
  );
  assert.equal((result as { block?: boolean }).block, true);
  assert.match(String((result as { reason?: string }).reason), /Human approval required/);
});

test("human file approval is invalidated by a session change", async () => {
  const runtime = mkdtempSync(join(tmpdir(), "pi-permission-reviewer-runtime-"));
  process.env.PI_PERMISSION_REVIEWER_RUNTIME_DIR = runtime;
  const piPermConfig = join(runtime, "pi-perm.toml");
  writeFileSync(piPermConfig, '[tools.bash]\nsrtBinary = "true"\n');
  process.env.PI_PERM_USER_CONFIG = piPermConfig;
  const reviewerConfig = join(runtime, "reviewers.json");
  writeFileSync(reviewerConfig, JSON.stringify({ reviewers: [] }));
  process.env.PI_PERMISSION_REVIEWER_CONFIG = reviewerConfig;
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    events: { emit() {} },
    getAllTools: () => builtinTool("read"),
    registerTool() {},
    registerCommand() {},
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
    },
  };
  await permissionReviewer(pi as any);
  const result = await handlers.get("tool_call")!(
    { toolName: "read", toolCallId: "stale-human-read", input: { path: "/review-target" } },
    {
      cwd: process.cwd(),
      hasUI: true,
      modelRegistry: {},
      ui: {
        async confirm() {
          await handlers.get("session_start")!({}, { ui: { notify() {} } });
          return true;
        },
      },
    },
  ) as { block?: boolean; reason?: string };
  assert.equal(result.block, true);
  assert.match(String(result.reason), /session changed|cancelled/i);
});

test("a deterministic pi-perm file block cannot enter model review", async () => {
  const runtime = mkdtempSync(
    join(tmpdir(), "pi-permission-reviewer-runtime-"),
  );
  process.env.PI_PERMISSION_REVIEWER_RUNTIME_DIR = runtime;
  const piPermConfig = join(runtime, "pi-perm.toml");
  writeFileSync(piPermConfig, '[tools.bash]\nsrtBinary = "true"\n');
  process.env.PI_PERM_USER_CONFIG = piPermConfig;
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    events: { emit() {} },
    getAllTools: () => builtinTool("write"),
    registerTool() {},
    registerCommand() {},
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
    },
  };
  await permissionReviewer(pi as any);
  let modelCalled = false;
  const result = await handlers.get("tool_call")!(
    {
      toolName: "write",
      toolCallId: "blocked-file-operation",
      input: { path: ".env", content: "API_KEY=not-a-real-secret" },
    },
    {
      cwd: process.cwd(),
      hasUI: false,
      ui: {},
      modelRegistry: {
        find() {
          modelCalled = true;
        },
      },
    },
  );
  assert.equal(modelCalled, false);
  assert.equal((result as { block?: boolean }).block, true);
  assert.match(String((result as { reason?: string }).reason), /denied by permission profile/);
});

test("file review fails closed when the effective tool is not Pi's builtin", async () => {
  const runtime = mkdtempSync(join(tmpdir(), "pi-permission-reviewer-runtime-"));
  process.env.PI_PERMISSION_REVIEWER_RUNTIME_DIR = runtime;
  const piPermConfig = join(runtime, "pi-perm.toml");
  writeFileSync(piPermConfig, '[tools.bash]\nsrtBinary = "true"\n');
  process.env.PI_PERM_USER_CONFIG = piPermConfig;
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    events: { emit() {} },
    getAllTools: () => [{ name: "read", sourceInfo: { source: "extension" } }],
    registerTool() {},
    registerCommand() {},
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
    },
  };
  await permissionReviewer(pi as any);
  let modelCalled = false;
  const result = await handlers.get("tool_call")!(
    { toolName: "read", toolCallId: "overridden-read", input: { path: "/review-target" } },
    {
      cwd: process.cwd(),
      hasUI: false,
      ui: {},
      modelRegistry: { find() { modelCalled = true; } },
    },
  );
  assert.equal(modelCalled, false);
  assert.equal((result as { block?: boolean }).block, true);
  assert.match(String((result as { reason?: string }).reason), /not the built-in executor/);
});

test("a session change invalidates a non-cooperative file reviewer", async () => {
  const runtime = mkdtempSync(join(tmpdir(), "pi-permission-reviewer-runtime-"));
  process.env.PI_PERMISSION_REVIEWER_RUNTIME_DIR = runtime;
  const piPermConfig = join(runtime, "pi-perm.toml");
  writeFileSync(piPermConfig, '[tools.bash]\nsrtBinary = "true"\n');
  process.env.PI_PERM_USER_CONFIG = piPermConfig;
  const reviewerConfig = join(runtime, "reviewers.json");
  writeFileSync(reviewerConfig, JSON.stringify({ reviewers: [{ level: 0, model: "test/reviewer" }] }));
  process.env.PI_PERMISSION_REVIEWER_CONFIG = reviewerConfig;
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    events: { emit() {} },
    getAllTools: () => builtinTool("read"),
    registerTool() {},
    registerCommand() {},
    on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, handler); },
  };
  await permissionReviewer(pi as any);
  let started!: () => void;
  const reviewStarted = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const pending = handlers.get("tool_call")!(
    { toolName: "read", toolCallId: "stale-read", input: { path: "/review-target" } },
    {
      cwd: process.cwd(), hasUI: false, ui: {},
      modelRegistry: {
        find: () => ({ provider: "test", id: "reviewer" }),
        hasConfiguredAuth: () => true,
        complete: async () => {
          started();
          await released;
          return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ decision: "allow", reason: "safe" }) }] };
        },
      },
    },
  ) as Promise<unknown>;
  await reviewStarted;
  await handlers.get("session_start")!({}, { ui: { notify() {} } });
  release();
  const result = await pending as { block?: boolean; reason?: string };
  assert.equal(result.block, true);
  assert.match(String(result.reason), /session changed|cancelled/i);
});

test("an error after intercepted file confirmation remains terminal", async () => {
  const runtime = mkdtempSync(join(tmpdir(), "pi-permission-reviewer-runtime-"));
  process.env.PI_PERMISSION_REVIEWER_RUNTIME_DIR = runtime;
  const piPermConfig = join(runtime, "pi-perm.toml");
  writeFileSync(piPermConfig, '[tools.bash]\nsrtBinary = "true"\n');
  process.env.PI_PERM_USER_CONFIG = piPermConfig;
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    events: { emit() {} },
    getAllTools: () => builtinTool("read"),
    registerTool() {}, registerCommand() {},
    on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, handler); },
  };
  await permissionReviewer(pi as any);
  let statusCalls = 0;
  let modelCalled = false;
  const result = await handlers.get("tool_call")!(
    { toolName: "read", toolCallId: "post-confirm-error", input: { path: "/review-target" } },
    {
      cwd: process.cwd(), hasUI: true,
      ui: {
        setStatus() { statusCalls += 1; if (statusCalls > 1) throw new Error("restore failed"); },
      },
      modelRegistry: { find() { modelCalled = true; } },
    },
  );
  assert.equal(modelCalled, false);
  assert.equal((result as { block?: boolean }).block, true);
  assert.match(String((result as { reason?: string }).reason), /restore failed/);
});

test("malformed pi-perm configuration installs a fail-closed gate", async () => {
  const runtime = mkdtempSync(
    join(tmpdir(), "pi-permission-reviewer-runtime-"),
  );
  process.env.PI_PERMISSION_REVIEWER_RUNTIME_DIR = runtime;
  const piPermConfig = join(runtime, "malformed.toml");
  writeFileSync(piPermConfig, "[this is not valid toml");
  process.env.PI_PERM_USER_CONFIG = piPermConfig;
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    events: { emit() {} },
    registerTool() {},
    registerCommand() {},
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
    },
  };
  await permissionReviewer(pi as any);
  const result = handlers.get("tool_call")!({
    toolName: "bash",
    toolCallId: "must-block",
    input: { command: "pwd" },
  });
  assert.equal((result as { block?: boolean }).block, true);
  assert.match(
    String((result as { reason?: string }).reason),
    /failed to initialize/,
  );
});

test("an in-flight model approval is invalidated by a config reload", async () => {
  const runtime = mkdtempSync(
    join(tmpdir(), "pi-permission-reviewer-runtime-"),
  );
  process.env.PI_PERMISSION_REVIEWER_RUNTIME_DIR = runtime;
  const piPermConfig = join(runtime, "pi-perm.toml");
  writeFileSync(piPermConfig, '[tools.bash]\nsrtBinary = "true"\n');
  process.env.PI_PERM_USER_CONFIG = piPermConfig;
  const reviewerConfig = join(runtime, "reviewers.json");
  writeFileSync(
    reviewerConfig,
    JSON.stringify({ reviewers: [{ level: 0, model: "test/reviewer" }] }),
  );
  process.env.PI_PERMISSION_REVIEWER_CONFIG = reviewerConfig;

  const handlers = new Map<string, (...args: any[]) => unknown>();
  const commands = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    events: { emit() {} },
    registerTool() {},
    registerCommand(name: string, command: { handler: (...args: any[]) => unknown }) {
      commands.set(name, command.handler);
    },
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
    },
  };
  await permissionReviewer(pi as any);

  let finishReview!: () => void;
  const reviewStarted = new Promise<void>((resolveStarted) => {
    finishReview = resolveStarted;
  });
  let releaseReview!: () => void;
  const reviewReleased = new Promise<void>((resolveReleased) => {
    releaseReview = resolveReleased;
  });
  const model = { provider: "test", id: "reviewer" };
  const toolResult = handlers.get("tool_call")!(
    {
      toolName: "bash",
      toolCallId: "config-race",
      input: { command: "echo hello" },
    },
    {
      cwd: process.cwd(),
      hasUI: false,
      signal: undefined,
      ui: {},
      modelRegistry: {
        find: () => model,
        hasConfiguredAuth: () => true,
        complete: async () => {
          finishReview();
          await reviewReleased;
          return {
            stopReason: "stop",
            content: [
              {
                type: "text",
                text: JSON.stringify({ decision: "allow", reason: "safe" }),
              },
            ],
          };
        },
      },
    },
  ) as Promise<unknown>;
  await reviewStarted;
  writeFileSync(reviewerConfig, JSON.stringify({ reviewers: [] }));
  await commands.get("permission-reviewer")!("reload", {
    hasUI: false,
    scopedModels: [],
    modelRegistry: {},
    ui: { notify() {} },
  });
  releaseReview();

  const result = (await toolResult) as { block?: boolean; reason?: string };
  assert.equal(result.block, true);
  assert.match(String(result.reason), /configuration changed/);
});
