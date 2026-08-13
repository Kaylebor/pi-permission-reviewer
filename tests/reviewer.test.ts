import assert from "node:assert/strict";
import test from "node:test";
import {
  invokeNetworkReviewer,
  parseAssessment,
} from "../src/reviewer.ts";

test("parses the strict reviewer contract", () => {
  assert.deepEqual(
    parseAssessment('{"decision":"escalate","reason":"dynamic target"}'),
    { decision: "escalate", reason: "dynamic target" },
  );
});

test("rejects decisions outside the contract", () => {
  assert.throws(
    () => parseAssessment('{"decision":"maybe","reason":"unknown"}'),
    /decision is invalid/,
  );
});

test("network follow-up reuses the original reviewer and review context", async () => {
  let payload: any;
  const model = { provider: "test", id: "reviewer" };
  const result = await invokeNetworkReviewer(
    {
      find: () => model,
      hasConfiguredAuth: () => true,
      complete: async (_model: unknown, context: any) => {
        payload = JSON.parse(context.messages[0].content);
        return {
          stopReason: "stop",
          content: [
            {
              type: "text",
              text: JSON.stringify({ decision: "allow", reason: "expected host" }),
            },
          ],
        };
      },
    } as any,
    { level: 0, model: "test/reviewer" },
    {
      tool: "bash",
      input: { command: "git fetch origin" },
      cwd: "/workspace",
      minimumLevel: 0,
      directUserInput: "fetch updates",
    },
    { decision: "allow", reason: "read-only fetch" },
    { host: "github.com", port: 443 },
    "Only authorized repository reads.",
    undefined,
  );
  assert.equal(result.kind, "assessment");
  assert.equal(payload.request.input.command, "git fetch origin");
  assert.match(JSON.stringify(payload.continuation), /github\.com/);
  assert.match(JSON.stringify(payload.continuation), /read-only fetch/);
});

test("reviewer transcripts carry the prior assessment into a local continuation", async () => {
  const contexts: any[] = [];
  const model = { provider: "test", id: "reviewer" };
  const { createReviewerTranscript, invokeModelReviewer } = await import("../src/reviewer.ts");
  const transcript = createReviewerTranscript();
  const registry = {
    find: () => model,
    hasConfiguredAuth: () => true,
    complete: async (_model: unknown, context: any) => {
      contexts.push(context);
      return { stopReason: "stop", content: [{ type: "text", text: '{"decision":"allow","reason":"ok"}' }] };
    },
  } as any;
  const request = { tool: "bash", input: { command: "pwd" }, cwd: "/w", minimumLevel: 0 };
  await invokeModelReviewer(registry, { reviewer: { level: 0, model: "test/reviewer" } }, request, undefined, undefined, { transcript });
  await invokeNetworkReviewer(registry, { level: 0, model: "test/reviewer" }, request, { decision: "allow", reason: "ok" }, { host: "github.com", port: 443 }, undefined, undefined, { transcript });
  assert.equal(contexts[1].messages.length, 3);
  assert.equal(transcript.messages.length, 4);
});
