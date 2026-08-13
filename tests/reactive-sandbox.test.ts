import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  canonicalizeNetworkDestination,
  hardenSandboxSettings,
  immutableWorkerEnvironment,
  runReactiveSandbox,
  sanitizedEnvironment,
} from "../src/reactive-sandbox.ts";
import type { NetworkDecision } from "../src/review-types.ts";

const workerPath = fileURLToPath(
  new URL("./fixtures/fake-sandbox-worker.mjs", import.meta.url),
);

function networkDecision(
  decision: NetworkDecision["decision"],
  source: NetworkDecision["source"] = "reviewer",
  caseId = "test-case",
): NetworkDecision {
  return { decision, source, caseId, reason: `${source} ${decision}` };
}

test("forwards Pi's bash timeout to the worker in milliseconds", async () => {
  const output: Buffer[] = [];
  const result = await runReactiveSandbox({
    toolCallId: "timeout-probe",
    command: "timeout-probe",
    cwd: process.cwd(),
    settings: {},
    workerPath,
    timeout: 15,
    onData: (data) => output.push(data),
    onNetworkRequest: async () => networkDecision("deny", "policy", "timeout-probe"),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(Buffer.concat(output).toString(), "15000");
});

test("one host-port review resumes the original worker and is cached per command", async () => {
  let reviews = 0;
  const decisions: Array<{ decision: NetworkDecision; destination: { host: string; port?: number } }> = [];
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
      return networkDecision("allow", "reviewer", "reactive-allow");
    },
    onNetworkDecision: (decision, destination) => decisions.push({ decision, destination }),
  });
  assert.equal(reviews, 1);
  assert.deepEqual(decisions, [{
    decision: networkDecision("allow", "reviewer", "reactive-allow"),
    destination: { host: "example.com", port: 443 },
  }]);
  assert.equal(result.exitCode, 0);
  assert.equal(Buffer.concat(output).toString(), "continued");
});

test("a mismatched tool-call request fails closed", async () => {
  let reviewed = false;
  const decisions: NetworkDecision[] = [];
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
        return networkDecision("allow");
      },
      onNetworkDecision: (decision) => decisions.push(decision),
      timeout: 0.05,
    }),
    /invalid request denied/,
  );
  assert.equal(reviewed, false);
  assert.deepEqual(decisions, [
    {
      decision: "deny",
      source: "error",
      reason: "invalid network request",
      caseId: "reactive-invalid",
    },
  ]);
});

test("only an allow decision crosses the Boolean worker IPC boundary", async () => {
  const decisions: NetworkDecision[] = [];
  await assert.rejects(
    runReactiveSandbox({
      toolCallId: "reactive-deny",
      command: "deny",
      cwd: process.cwd(),
      settings: {},
      workerPath,
      onData() {},
      onNetworkRequest: async () => networkDecision("deny", "policy", "reactive-deny"),
      onNetworkDecision: (decision) => decisions.push(decision),
    }),
    /network request denied/,
  );
  assert.deepEqual(decisions, [networkDecision("deny", "policy", "reactive-deny")]);
});

test("abort denies a pending network request and terminates the worker", async () => {
  const controller = new AbortController();
  const decisions: NetworkDecision[] = [];
  const running = runReactiveSandbox({
    toolCallId: "reactive-abort",
    command: "wait",
    cwd: process.cwd(),
    settings: {},
    workerPath,
    signal: controller.signal,
    onData() {},
    onNetworkDecision: (decision) => decisions.push(decision),
    onNetworkRequest: async () => new Promise<NetworkDecision>(() => {}),
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(running, /aborted/);
  assert.deepEqual(decisions, []);
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

test("only an explicit SSH-agent overlay crosses the worker boundary", () => {
  const inherited = process.env.SSH_AUTH_SOCK;
  try {
    process.env.SSH_AUTH_SOCK = "/private/tmp/inherited-agent.sock";
    assert.equal(immutableWorkerEnvironment({}).SSH_AUTH_SOCK, undefined);
    assert.equal(
      immutableWorkerEnvironment({ SSH_AUTH_SOCK: "/private/tmp/approved-agent.sock" })
        .SSH_AUTH_SOCK,
      "/private/tmp/approved-agent.sock",
    );
  } finally {
    if (inherited === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = inherited;
  }
});

test("an explicit invocation-local Git config overlay reaches the worker", async () => {
  const output: Buffer[] = [];
  await runReactiveSandbox({
    toolCallId: "git-env",
    command: "git-env",
    cwd: process.cwd(),
    settings: {},
    workerPath,
    environment: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "false",
    },
    onData: (data) => output.push(data),
    onNetworkRequest: async () => networkDecision("deny", "policy", "git-env"),
  });
  assert.deepEqual(JSON.parse(Buffer.concat(output).toString()), {
    count: "1",
    key: "core.fsmonitor",
    value: "false",
  });
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
      new Promise<NetworkDecision>((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve(networkDecision("allow"));
        }, { once: true });
      }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(aborted, true);
});

test("a non-cooperative reviewer is hard-timed-out and cannot retain the worker", async () => {
  const decisions: NetworkDecision[] = [];
  const result = await runReactiveSandbox({
    toolCallId: "reactive-hard-timeout",
    command: "single",
    cwd: process.cwd(),
    settings: {},
    workerPath,
    networkReviewTimeoutMs: 10,
    onData() {},
    onNetworkRequest: async () => new Promise<NetworkDecision>(() => {}),
    onNetworkDecision: (decision) => decisions.push(decision),
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(decisions, [{
    decision: "deny",
    source: "timeout",
    reason: "network review timed out",
    caseId: "reactive-hard-timeout",
  }]);
});

test("command settlement aborts an in-flight network review", async () => {
  let aborted = false;
  const decisions: NetworkDecision[] = [];
  const result = await runReactiveSandbox({
    toolCallId: "reactive-settle",
    command: "settle",
    cwd: process.cwd(),
    settings: {},
    workerPath,
    onData() {},
    onNetworkDecision: (decision) => decisions.push(decision),
    onNetworkRequest: async (_request, signal) =>
      new Promise<NetworkDecision>((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve(networkDecision("allow"));
        }, { once: true });
      }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(aborted, true);
  assert.deepEqual(decisions, []);
});

test("network reviews are serialized and capped per invocation", async () => {
  let active = 0;
  let maximumActive = 0;
  let reviews = 0;
  const decisions: Array<{ decision: NetworkDecision; destination: { host: string; port?: number } }> = [];
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
      return networkDecision("allow", "reviewer", "reactive-many");
    },
    onNetworkDecision: (decision, destination) => decisions.push({ decision, destination }),
  });
  assert.equal(reviews, 2);
  assert.equal(maximumActive, 1);
  assert.deepEqual(
    decisions.find(({ destination }) => destination.host === "three.example"),
    {
      decision: {
        decision: "deny",
        source: "limit",
        reason: "network destination review limit reached",
        caseId: "reactive-many",
      },
      destination: { host: "three.example", port: 443 },
    },
  );
});
