import assert from "node:assert/strict";
import test from "node:test";
import { groupEligibleReviewers, runReviewLevels } from "../src/levels.ts";

const reviewers = [
  { level: 0, model: "test/luna" },
  { level: 0, model: "test/luna-fallback" },
  { level: 1, model: "test/terra" },
  { level: 3, model: "test/strong" },
];

test("groups reviewers by ascending level while preserving array order", () => {
  assert.deepEqual(groupEligibleReviewers(reviewers, 0), [
    [0, reviewers.slice(0, 2)],
    [1, [reviewers[2]]],
    [3, [reviewers[3]]],
  ]);
});

test("tries each level at most once", async () => {
  const invoked: string[] = [];
  const result = await runReviewLevels({
    reviewers,
    minimumLevel: 0,
    invoke: async ({ reviewer }) => {
      invoked.push(reviewer.model);
      return reviewer.level < 3
        ? {
            kind: "assessment" as const,
            assessment: { decision: "escalate" as const, reason: "unsure" },
          }
        : {
            kind: "assessment" as const,
            assessment: { decision: "allow" as const, reason: "bounded" },
          };
    },
  });
  assert.deepEqual(invoked, ["test/luna", "test/terra", "test/strong"]);
  assert.equal(result.decision, "allow");
});

test("skips unavailable ties but invokes at most one ready peer", async () => {
  const invoked: string[] = [];
  const result = await runReviewLevels({
    reviewers,
    minimumLevel: 0,
    invoke: async ({ reviewer }) => {
      invoked.push(reviewer.model);
      if (reviewer.model === "test/luna") {
        return { kind: "unavailable", error: "not authenticated" };
      }
      return {
        kind: "assessment",
        assessment: { decision: "allow", reason: "bounded" },
      };
    },
  });
  assert.deepEqual(invoked, ["test/luna", "test/luna-fallback"]);
  assert.equal(result.decision, "allow");
});

test("starts at the assigned minimum level", async () => {
  const invoked: string[] = [];
  await runReviewLevels({
    reviewers,
    minimumLevel: 1,
    invoke: async ({ reviewer }) => {
      invoked.push(reviewer.model);
      return {
        kind: "assessment",
        assessment: { decision: "deny", reason: "unsafe" },
      };
    },
  });
  assert.deepEqual(invoked, ["test/terra"]);
});

test("exhaustion falls back to a human", async () => {
  const result = await runReviewLevels({
    reviewers: reviewers.slice(0, 1),
    minimumLevel: 0,
    invoke: async () => ({ kind: "timeout", error: "deadline" }),
  });
  assert.equal(result.decision, "human");
});

test("cancellation blocks without traversing higher levels", async () => {
  const invoked: string[] = [];
  const result = await runReviewLevels({
    reviewers,
    minimumLevel: 0,
    invoke: async ({ reviewer }) => {
      invoked.push(reviewer.model);
      return { kind: "cancelled", error: "parent aborted" };
    },
  });
  assert.deepEqual(invoked, ["test/luna"]);
  assert.equal(result.decision, "deny");
});
