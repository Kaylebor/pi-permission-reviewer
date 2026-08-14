import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReviewerSystemPrompt,
  createReviewerTranscript,
  invokeModelReviewer,
  invokeHttpReviewer,
  invokeNetworkReviewer,
  parseAssessment,
  transcriptRetainsEvidence,
} from "../src/reviewer.ts";

test("Guardian prompt permits bounded implicit context reads and accepts local extensions", () => {
  const builtIn = buildReviewerSystemPrompt();
  assert.match(builtIn, /installed skill definitions/);
  assert.match(builtIn, /user need not name every such file/);
  assert.match(builtIn, /does not authorize[\s\S]*credentials or secrets/);
  assert.match(builtIn, /cannot inspect its method, URL\s+path/);

  const extended = buildReviewerSystemPrompt(
    "Allow bounded reads of my portable agent configuration.",
  );
  assert.match(extended, /<guardian_extension>/);
  assert.match(extended, /portable agent configuration/);
  assert.ok(
    extended.indexOf("portable agent configuration") <
      extended.indexOf("required response schema"),
  );
});

test("model review receives the configured Guardian prompt as system guidance", async () => {
  let systemPrompt = "";
  const result = await invokeModelReviewer(
    {
      find: () => ({ provider: "test", id: "reviewer" }),
      hasConfiguredAuth: () => true,
      complete: async (_model: unknown, context: { systemPrompt: string }) => {
        systemPrompt = context.systemPrompt;
        return {
          stopReason: "stop",
          content: [{ type: "text", text: '{"decision":"allow","reason":"bounded"}' }],
        };
      },
    } as any,
    { reviewer: { level: 0, model: "test/reviewer" } },
    { tool: "read", input: { path: "/repo/SKILL.md" }, cwd: "/repo", minimumLevel: 0 },
    undefined,
    undefined,
    { guardianPrompt: "Allow task-relevant installed skill reads." },
  );
  assert.equal(result.kind, "assessment");
  assert.match(systemPrompt, /Allow task-relevant installed skill reads/);
});

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
  assert.match(JSON.stringify(payload.continuation), /HTTP method, path, headers, body/);
});

test("HTTP follow-up receives sanitized request metadata as a scoped continuation", async () => {
  let payload: any;
  const result = await invokeHttpReviewer(
    {
      find: () => ({ provider: "test", id: "reviewer" }),
      hasConfiguredAuth: () => true,
      complete: async (_model: unknown, context: any) => {
        payload = JSON.parse(context.messages[0].content);
        return {
          stopReason: "stop",
          content: [{ type: "text", text: '{"decision":"allow","reason":"bounded request"}' }],
        };
      },
    } as any,
    { level: 0, model: "test/reviewer" },
    { tool: "bash", input: { command: "curl https://example.com/a" }, cwd: "/workspace", minimumLevel: 0 },
    { decision: "allow", reason: "authorized fetch" },
    {
      method: "GET",
      origin: "https://example.com",
      path: "/a",
      queryParameterNames: ["page"],
      sensitiveQueryParameterNames: [],
      headerNames: ["accept"],
      sensitiveHeaderNames: [],
      bodyPresent: false,
    },
    undefined,
    undefined,
  );
  assert.equal(result.kind, "assessment");
  assert.equal(payload.continuation.sanitizedHttpRequest.path, "/a");
  assert.match(payload.continuation.instruction, /Header values, query values, raw body bytes/);
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
  const evidence = {
    mode: "metadata" as const,
    metadata: {
      observedMessages: 1,
      representedConversationMessages: 0,
      representedToolMessages: 0,
      omittedConversationMessages: 1,
      omittedToolMessages: 0,
      conversationTokens: 0,
      toolTokens: 0,
    },
  };
  await invokeModelReviewer(registry, { reviewer: { level: 0, model: "test/reviewer" } }, request, undefined, undefined, { transcript, evidence, caseId: "case-1" });
  await invokeNetworkReviewer(registry, { level: 0, model: "test/reviewer" }, request, { decision: "allow", reason: "ok" }, { host: "github.com", port: 443 }, undefined, undefined, { transcript, caseId: "case-1" });
  assert.equal(contexts[1].messages.length, 3);
  assert.equal(transcript.messages.length, 4);
  assert.deepEqual(transcript.pairs, [
    { caseId: "case-1", hasEvidence: true },
    { caseId: "case-1", hasEvidence: false },
  ]);
  assert.ok(JSON.parse(contexts[0].messages[0].content).context);
  assert.equal(JSON.parse(contexts[1].messages[2].content).context, undefined);
});

test("evidence deduplication stops when pruning removes its message pair", async () => {
  const transcript = createReviewerTranscript();
  const model = { provider: "test", id: "reviewer" };
  const registry = {
    find: () => model,
    hasConfiguredAuth: () => true,
    complete: async () => ({
      api: "test",
      provider: "test",
      model: "reviewer",
      stopReason: "stop",
      content: [{ type: "text", text: '{"decision":"allow","reason":"ok"}' }],
    }),
  } as any;
  const request = { tool: "bash", input: { command: "pwd" }, cwd: "/w", minimumLevel: 0 };
  const evidence = {
    mode: "transcript" as const,
    metadata: {
      observedMessages: 1,
      representedConversationMessages: 1,
      representedToolMessages: 0,
      omittedConversationMessages: 0,
      omittedToolMessages: 0,
      conversationTokens: 30_000,
      toolTokens: 0,
    },
    conversation: [{ role: "user" as const, text: "x".repeat(90_000) }],
    tools: [],
  };
  await invokeModelReviewer(
    registry,
    { reviewer: { level: 0, model: "test/reviewer" } },
    request,
    undefined,
    undefined,
    { transcript, evidence, caseId: "large-case" },
  );
  assert.equal(transcript.messages.length, 0);
  assert.equal(transcriptRetainsEvidence(transcript, "large-case"), false);
});

test("reviewer timeout is hard-bounded when the provider ignores cancellation", async () => {
  const registry = {
    find: () => ({ provider: "test", id: "reviewer" }),
    hasConfiguredAuth: () => true,
    complete: async () => new Promise(() => {}),
  } as any;
  const started = Date.now();
  const result = await invokeModelReviewer(
    registry,
    { reviewer: { level: 0, model: "test/reviewer", timeoutMs: 20 } },
    { tool: "read", input: { path: "/outside" }, cwd: "/w", minimumLevel: 0 },
    undefined,
    undefined,
  );
  assert.equal(result.kind, "timeout");
  assert.ok(Date.now() - started < 1_000);
});

test("invalidated reviews do not enter persistent reviewer history", async () => {
  const transcript = createReviewerTranscript();
  const registry = {
    find: () => ({ provider: "test", id: "reviewer" }),
    hasConfiguredAuth: () => true,
    complete: async () => ({
      stopReason: "stop",
      content: [{ type: "text", text: '{"decision":"allow","reason":"ok"}' }],
    }),
  } as any;
  const result = await invokeModelReviewer(
    registry,
    { reviewer: { level: 0, model: "test/reviewer" } },
    { tool: "read", input: { path: "/outside" }, cwd: "/w", minimumLevel: 0 },
    undefined,
    undefined,
    {
      transcript,
      caseId: "cancelled-case",
      validateBeforeCommit: () => "file review was invalidated",
    },
  );
  assert.equal(result.kind, "cancelled");
  assert.deepEqual(transcript.messages, []);
  assert.deepEqual(transcript.pairs, []);
});
