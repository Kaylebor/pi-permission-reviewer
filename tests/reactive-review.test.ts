import assert from "node:assert/strict";
import test from "node:test";
import {
  reviewHttpRequest,
  type ReactiveAnchor,
} from "../extensions/index.ts";
import type { ApprovalCapability } from "../src/review-types.ts";
import type { ReactiveReviewConfig, ReviewerConfig } from "../src/types.ts";

const reviewers: ReviewerConfig[] = [
  { level: 0, model: "test/base", reasoning: "medium" },
  { level: 1, model: "test/strong", reasoning: "high" },
];

const baseConfig: ReactiveReviewConfig = {
  reasoning: "one-lower",
  floor: "low",
  inspection: "http-metadata",
  incompleteBodyApproval: "human",
  requestIdentityIgnoredHeaders: [],
};

function capability(): ApprovalCapability {
  return {
    reviewCase: {
      id: "case-1",
      sessionEpoch: 1,
      configGeneration: 1,
      toolCallId: "call-1",
      tool: "bash",
      input: { command: "curl https://example.com" },
      inputDigest: "a".repeat(64),
      cwd: "/workspace",
      minimumLevel: 0,
      sandboxSettings: {},
    },
    request: {
      tool: "bash",
      input: { command: "curl https://example.com" },
      cwd: "/workspace",
      minimumLevel: 0,
    },
    reviewer: reviewers[0],
    assessment: { decision: "allow", reason: "authorized fetch" },
  };
}

function summary(complete: boolean) {
  return {
    method: "POST",
    origin: "https://example.com",
    path: "/api",
    queryParameterNames: [],
    sensitiveQueryParameterNames: [],
    headerNames: ["content-type"],
    sensitiveHeaderNames: [],
    bodyPresent: true,
    bodyObservedBytes: complete ? 4 : 65_537,
    bodyComplete: complete,
    ...(complete ? { bodySha256: "b".repeat(64) } : { bodyRiskFlags: ["body-over-limit"] }),
  };
}

function context(
  decide: (modelId: string) => "allow" | "deny" | "escalate" | "human",
  confirm: () => Promise<boolean> = async () => true,
) {
  return {
    hasUI: true,
    ui: { confirm },
    modelRegistry: {
      find: (_provider: string, id: string) => ({ provider: "test", id }),
      hasConfiguredAuth: () => true,
      complete: async (model: { id: string }) => ({
        stopReason: "stop",
        content: [{
          type: "text",
          text: JSON.stringify({
            decision: decide(model.id),
            reason: `${model.id} assessment`,
          }),
        }],
      }),
    },
  } as any;
}

function anchorMap(): Map<string, ReactiveAnchor> {
  return new Map([["case-1", {
    reviewer: reviewers[0]!,
    assessment: { decision: "allow", reason: "authorized fetch" },
  }]]);
}

test("incomplete bodies require human approval by default even after reviewer allow", async () => {
  let confirmations = 0;
  const anchors = anchorMap();
  const result = await reviewHttpRequest(
    capability(),
    summary(false),
    context(() => "allow", async () => {
      confirmations += 1;
      return true;
    }),
    undefined,
    1,
    reviewers,
    baseConfig,
    undefined,
    "command",
    new Map(),
    new Map(),
    anchors,
  );
  assert.equal(result.source, "human");
  assert.equal(result.decision, "allow");
  assert.equal(confirmations, 1);
});

test("reviewer mode may allow an incomplete body without a human prompt", async () => {
  let confirmations = 0;
  const result = await reviewHttpRequest(
    capability(),
    summary(false),
    context(() => "allow", async () => {
      confirmations += 1;
      return true;
    }),
    undefined,
    1,
    reviewers,
    { ...baseConfig, incompleteBodyApproval: "reviewer" },
    undefined,
    "command",
    new Map(),
    new Map(),
    anchorMap(),
  );
  assert.equal(result.source, "reviewer");
  assert.equal(result.decision, "allow");
  assert.equal(confirmations, 0);
});

test("a higher successful reactive reviewer anchors the next request", async () => {
  const calls: string[] = [];
  const anchors = anchorMap();
  const ctx = context((model) => {
    calls.push(model);
    return model === "base" ? "escalate" : "allow";
  });
  for (const path of ["/first", "/second"]) {
    const result = await reviewHttpRequest(
      capability(),
      { ...summary(true), path },
      ctx,
      undefined,
      1,
      reviewers,
      { ...baseConfig, incompleteBodyApproval: "reviewer" },
      undefined,
      "command",
      new Map(),
      new Map(),
      anchors,
    );
    assert.equal(result.decision, "allow");
  }
  assert.deepEqual(calls, ["base", "strong", "strong"]);
  assert.equal(anchors.get("case-1")?.reviewer.model, "test/strong");
});
