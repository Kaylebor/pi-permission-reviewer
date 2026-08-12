import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  canonicalizeNetworkDestination,
  hardenSandboxSettings,
  runReactiveSandbox,
  sanitizedEnvironment,
} from "../src/reactive-sandbox.ts";

const workerPath = fileURLToPath(
  new URL("./fixtures/fake-sandbox-worker.mjs", import.meta.url),
);

test("one host-port review resumes the original worker and is cached per command", async () => {
  let reviews = 0;
  const output: Buffer[] = [];
  const result = await runReactiveSandbox({
    toolCallId: "reactive-allow",
    command: "duplicate",
    cwd: process.cwd(),
    settings: {},
    workerPath,
    onData: (data) => output.push(data),
    onNetworkRequest: async (request) => {
      reviews += 1;
      assert.deepEqual(request, { host: "example.com", port: 443 });
      return true;
    },
  });
  assert.equal(reviews, 1);
  assert.equal(result.exitCode, 0);
  assert.equal(Buffer.concat(output).toString(), "continued");
});

test("a mismatched tool-call request fails closed", async () => {
  let reviewed = false;
  await assert.rejects(
    runReactiveSandbox({
      toolCallId: "reactive-invalid",
      command: "invalid",
      cwd: process.cwd(),
      settings: {},
      workerPath,
      onData() {},
      onNetworkRequest: async () => {
        reviewed = true;
        return true;
      },
      timeout: 0.05,
    }),
    /invalid request denied/,
  );
  assert.equal(reviewed, false);
});

test("abort denies a pending network request and terminates the worker", async () => {
  const controller = new AbortController();
  const running = runReactiveSandbox({
    toolCallId: "reactive-abort",
    command: "wait",
    cwd: process.cwd(),
    settings: {},
    workerPath,
    signal: controller.signal,
    onData() {},
    onNetworkRequest: async () => new Promise<boolean>(() => {}),
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(running, /aborted/);
});

test("sandbox settings add sensitive credential read denials", () => {
  const settings = hardenSandboxSettings({
    filesystem: { denyRead: ["existing"] },
    network: { allowedDomains: [] },
  }) as any;
  assert.ok(settings.filesystem.denyRead.includes("existing"));
  assert.ok(settings.filesystem.denyRead.includes("~/.ssh"));
  assert.ok(settings.filesystem.denyRead.includes("~/.pi/agent/auth.json"));
  assert.deepEqual(settings.network, { allowedDomains: [] });
});

test("worker environment strips common secret-bearing variables", () => {
  assert.deepEqual(
    sanitizedEnvironment({
      PATH: "/bin",
      HOME: "/home/test",
      LANG: "C",
      OPENAI_API_KEY: "secret",
      GH_TOKEN: "secret",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      PI_SESSION_FILE: "/home/test/.pi/session.jsonl",
      PI_SESSION_ID: "session",
    }),
    {
      PATH: "/bin",
      HOME: "/home/test",
      LANG: "C",
    },
  );
});

test("network destinations use one canonical representation", () => {
  assert.deepEqual(
    canonicalizeNetworkDestination({ host: "127.1", port: 443 }),
    { host: "127.0.0.1", port: 443 },
  );
  assert.deepEqual(
    canonicalizeNetworkDestination({ host: "[::ffff:127.0.0.1]", port: 443 }),
    { host: "::ffff:7f00:1", port: 443 },
  );
});

test("a timed-out review is aborted before the queue advances", async () => {
  let aborted = false;
  const result = await runReactiveSandbox({
    toolCallId: "reactive-timeout",
    command: "single",
    cwd: process.cwd(),
    settings: {},
    workerPath,
    networkReviewTimeoutMs: 10,
    onData() {},
    onNetworkRequest: async (_request, signal) =>
      new Promise<boolean>((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve(false);
        }, { once: true });
      }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(aborted, true);
});

test("command settlement aborts an in-flight network review", async () => {
  let aborted = false;
  const result = await runReactiveSandbox({
    toolCallId: "reactive-settle",
    command: "settle",
    cwd: process.cwd(),
    settings: {},
    workerPath,
    onData() {},
    onNetworkRequest: async (_request, signal) =>
      new Promise<boolean>((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve(false);
        }, { once: true });
      }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(aborted, true);
});

test("network reviews are serialized and capped per invocation", async () => {
  let active = 0;
  let maximumActive = 0;
  let reviews = 0;
  await runReactiveSandbox({
    toolCallId: "reactive-many",
    command: "many",
    cwd: process.cwd(),
    settings: {},
    workerPath,
    networkRequestLimit: 2,
    onData() {},
    onNetworkRequest: async () => {
      reviews += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return true;
    },
  });
  assert.equal(reviews, 2);
  assert.equal(maximumActive, 1);
});
