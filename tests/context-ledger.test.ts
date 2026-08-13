import assert from "node:assert/strict";
import test from "node:test";
import {
  ContextLedger,
  formatReviewEvidence,
} from "../src/context-ledger.ts";

test("captures context snapshots and finalized message deltas", () => {
  const ledger = new ContextLedger();
  const user = { role: "user", content: "inspect this repository", timestamp: 1 };
  const assistant = {
    role: "assistant",
    content: [{ type: "text", text: "I will inspect it." }],
    diagnostics: [{ request: "must not appear" }],
    timestamp: 2,
  };
  ledger.captureContext([user]);
  ledger.captureMessageEnd(assistant);
  ledger.captureMessageEnd(assistant);

  const evidence = ledger.buildEvidence();
  assert.equal(evidence.mode, "transcript");
  assert.deepEqual(evidence.conversation?.map(({ role, text }) => ({ role, text })), [
    { role: "user", text: "inspect this repository" },
    { role: "assistant", text: "I will inspect it." },
  ]);
  assert.equal(evidence.metadata.observedMessages, 2);
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(Object.isFrozen(evidence.conversation), true);

  ledger.captureContext([user]);
  assert.equal(ledger.buildEvidence().metadata.observedMessages, 1);
});

test("redacts secrets and excludes images, thinking, and diagnostics", () => {
  const ledger = new ContextLedger();
  ledger.captureContext([
    {
      role: "user",
      content: [
        { type: "text", text: "token=super-secret-value and keep image" },
        { type: "image", data: "base64-secret", mimeType: "image/png" },
      ],
      timestamp: 1,
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "curl uses Authorization: Bearer abcdefghijklmnop" },
        { type: "toolCall", name: "bash", arguments: { apiKey: "never-send" } },
      ],
      diagnostics: [{ rawRequest: "never-send" }],
      timestamp: 2,
    },
  ]);
  const rendered = formatReviewEvidence(ledger.buildEvidence());
  assert.match(rendered, /\[image omitted\]/);
  assert.match(rendered, /token=\[REDACTED\]/);
  assert.match(rendered, /Bearer \[REDACTED\]/);
  assert.match(rendered, /apiKey\\?":\\?"\[REDACTED\]/);
  assert.doesNotMatch(rendered, /private reasoning|base64-secret|never-send|rawRequest/);
});

test("keeps initial authorization and recent evidence within separate budgets", () => {
  const ledger = new ContextLedger();
  ledger.captureContext([
    { role: "user", content: "initial authorized purpose", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "old status ".repeat(100) }], timestamp: 2 },
    { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "output ".repeat(100) }], isError: false, timestamp: 3 },
    { role: "assistant", content: [{ type: "text", text: "latest relevant status" }], timestamp: 4 },
  ]);
  const evidence = ledger.buildEvidence({ conversationTokens: 20, toolTokens: 12 });
  assert.ok(evidence.metadata.conversationTokens <= 20);
  assert.ok(evidence.metadata.toolTokens <= 12);
  assert.equal(evidence.conversation?.[0].text, "initial authorized purpose");
  assert.match(evidence.tools?.[0].text ?? "", /truncated/);
});

test("metadata mode retains no transcript text", () => {
  const ledger = new ContextLedger();
  ledger.captureContext([
    { role: "user", content: "do not disclose this in metadata mode", timestamp: 1 },
  ]);
  const evidence = ledger.buildEvidence({ mode: "metadata" });
  assert.equal(evidence.conversation, undefined);
  assert.equal(evidence.tools, undefined);
  assert.doesNotMatch(formatReviewEvidence(evidence), /do not disclose/);
});

test("caps structural entries and redacts JSON, AWS, and JWT-shaped secrets", () => {
  const ledger = new ContextLedger();
  ledger.captureContext([
    { role: "user", content: JSON.stringify({ password: "hunter2", aws: "AKIA1234567890ABCDEF", jwt: "eyJabc.def.ghi" }), timestamp: 1 },
    ...Array.from({ length: 200 }, (_, index) => ({ role: "assistant", content: [{ type: "text", text: "" }], timestamp: index + 2 })),
  ]);
  const evidence = ledger.buildEvidence({ conversationTokens: 4_000 });
  const rendered = formatReviewEvidence(evidence);
  assert.ok((evidence.conversation?.length ?? 0) <= 80);
  assert.doesNotMatch(rendered, /hunter2|AKIA1234567890ABCDEF|eyJabc\.def\.ghi/);
  assert.match(rendered, /\[REDACTED\]/);
});
