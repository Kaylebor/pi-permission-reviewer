import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import permissionReviewer from "../extensions/index.ts";

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
  const result = await handlers.get("tool_call")!(event, {
    cwd: process.cwd(),
    hasUI: true,
    ui: { confirm: async () => true },
  });
  assert.equal(result, undefined);
  assert.throws(() => {
    event.input.path = "~/.ssh/id_ed25519";
  }, TypeError);
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
