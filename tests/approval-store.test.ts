import assert from "node:assert/strict";
import test from "node:test";
import {
  ApprovalStore,
  CAPABILITY_TTL_MS,
  canonicalSha256,
  createReviewCase,
} from "../src/approval-store.ts";
import type { ApprovalCapability } from "../src/review-types.ts";

function capability(overrides: Partial<Parameters<typeof createReviewCase>[0]> = {}): ApprovalCapability {
  const reviewCase = createReviewCase({
    id: "case-1",
    sessionEpoch: 4,
    configGeneration: 9,
    toolCallId: "tool-call-1",
    tool: "bash",
    input: { command: "git status", options: { short: true } },
    cwd: "/workspace",
    minimumLevel: 1,
    guardianPrompt: "Allow bounded skill-definition reads.",
    sandboxSettings: { allowNetwork: false, nested: { mode: "strict" } },
    ...overrides,
  });
  return {
    reviewCase,
    request: {
      tool: reviewCase.tool,
      input: reviewCase.input as Record<string, unknown>,
      cwd: reviewCase.cwd,
      minimumLevel: reviewCase.minimumLevel,
    },
  };
}

function invocation(overrides: Partial<Parameters<ApprovalStore["consume"]>[0]> = {}) {
  return {
    toolCallId: "tool-call-1",
    tool: "bash",
    input: { options: { short: true }, command: "git status" },
    cwd: "/workspace",
    configGeneration: 9,
    sessionEpoch: 4,
    ...overrides,
  };
}

test("review cases deeply clone and freeze their execution boundary", () => {
  const input = { command: "git status", nested: { paths: ["README.md"] } };
  const settings = { network: { allow: false } };
  const reviewCase = createReviewCase({
    id: "case-immutable",
    sessionEpoch: 1,
    configGeneration: 2,
    toolCallId: "call",
    tool: "bash",
    input,
    cwd: "/repo",
    minimumLevel: 0,
    sandboxSettings: settings,
  });
  input.nested.paths[0] = "changed";
  settings.network.allow = true;
  assert.deepEqual(reviewCase.input, { command: "git status", nested: { paths: ["README.md"] } });
  assert.deepEqual(reviewCase.sandboxSettings, { network: { allow: false } });
  assert.ok(Object.isFrozen(reviewCase));
  assert.ok(Object.isFrozen(reviewCase.input));
  assert.ok(Object.isFrozen((reviewCase.input.nested as object)));
  assert.ok(Object.isFrozen(reviewCase.sandboxSettings));
  assert.throws(() => {
    (reviewCase.input as { command: string }).command = "rm -rf /";
  }, TypeError);
});

test("canonical digests ignore property insertion order", () => {
  assert.equal(
    canonicalSha256({ z: [2, { b: true, a: "x" }], a: 1 }),
    canonicalSha256({ a: 1, z: [2, { a: "x", b: true }] }),
  );
});

test("review cases reject non-JSON-like input and settings", () => {
  assert.throws(() => capability({ input: { value: new Date() } }), /non-plain/);
  assert.throws(() => capability({ sandboxSettings: { value: Infinity } }), /non-finite/);
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => capability({ input: cyclic }), /cycle/);
});

test("consume accepts the exact immutable capability once", () => {
  const store = new ApprovalStore();
  assert.equal(store.remember(capability()), true);
  const consumed = store.consume(invocation());
  assert.equal(consumed.ok, true);
  if (consumed.ok) {
    assert.deepEqual(consumed.capability.reviewCase.sandboxSettings, {
      allowNetwork: false,
      nested: { mode: "strict" },
    });
    assert.ok(Object.isFrozen(consumed.capability.reviewCase.sandboxSettings));
    assert.equal(
      consumed.capability.reviewCase.guardianPrompt,
      "Allow bounded skill-definition reads.",
    );
  }
  assert.deepEqual(store.consume(invocation()), { ok: false, reason: "replayed" });
});

test("remember is first-wins and retains a private capability snapshot", () => {
  const store = new ApprovalStore();
  const saved = capability();
  assert.equal(store.remember(saved), true);
  assert.equal(store.remember(capability({ input: { command: "curl evil.example" } })), false);
  const result = store.consume(invocation());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.notStrictEqual(result.capability.reviewCase, saved.reviewCase);
    assert.notStrictEqual(
      result.capability.reviewCase.sandboxSettings,
      saved.reviewCase.sandboxSettings,
    );
    assert.equal(result.capability.reviewCase.sandboxSettings.allowNetwork, false);
  }
});

test("consume fails closed for every bound invocation field", () => {
  const checks = [
    { tool: "shell" },
    { input: { command: "git log" } },
    { cwd: "/other" },
    { configGeneration: 10 },
    { sessionEpoch: 5 },
  ];
  for (const change of checks) {
    const store = new ApprovalStore();
    store.remember(capability());
    assert.deepEqual(store.consume(invocation(change)), { ok: false, reason: "mismatch" });
  }
});

test("a different tool-call ID cannot consume a stored capability", () => {
  const store = new ApprovalStore();
  store.remember(capability());
  assert.deepEqual(
    store.consume(invocation({ toolCallId: "other" })),
    { ok: false, reason: "missing" },
  );
  assert.equal(store.consume(invocation()).ok, true);
});

test("missing, expiry, clear, and clearAll do not leave authorizations behind", () => {
  let now = 1_000;
  const store = new ApprovalStore({ now: () => now });
  assert.deepEqual(store.consume(invocation()), { ok: false, reason: "missing" });
  assert.equal(store.remember(capability()), true);
  now += CAPABILITY_TTL_MS;
  assert.deepEqual(store.consume(invocation()), { ok: false, reason: "expired" });
  store.clear("tool-call-1");
  assert.deepEqual(store.consume(invocation()), { ok: false, reason: "missing" });
  assert.equal(store.remember(capability()), true);
  store.clearAll();
  assert.deepEqual(store.consume(invocation()), { ok: false, reason: "missing" });
});
