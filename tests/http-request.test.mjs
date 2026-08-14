import assert from "node:assert/strict";
import test from "node:test";
import {
  httpRequestScopeFingerprint,
  isUninspectableHttpRequest,
  summarizeHttpRequest,
} from "../src/http-request.mjs";

test("HTTP summaries redact values and expose only bounded request characteristics", async () => {
  const secret = "correct-horse-battery-staple";
  const token = "eyJhbGciOiJIUzI1NiJ9.abcdefghijklmno.signaturepart";
  const request = new Request(
    `https://api.example.com/v1/${token}/upload?access_token=${secret}&page=2`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json; charset=utf-8",
        "x-request-id": "public-shape-only",
      },
      body: JSON.stringify({ password: secret }),
    },
  );
  const summary = await summarizeHttpRequest(request);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("Bearer"), false);
  assert.match(summary.path, /\[REDACTED\]/);
  assert.deepEqual(summary.queryParameterNames, ["[SENSITIVE_1]", "page"]);
  assert.deepEqual(summary.sensitiveQueryParameterNames, ["[SENSITIVE_1]"]);
  assert.ok(summary.sensitiveHeaderNames.includes("[SENSITIVE_1]"));
  assert.equal(summary.contentType, "application/json");
  assert.equal(summary.bodyComplete, true);
  assert.match(summary.bodySha256, /^[a-f0-9]{64}$/);
  assert.ok(summary.bodyRiskFlags.includes("secret-field-shape"));
});

test("declared GET bodies are marked uninspectable for deterministic denial", async () => {
  const summary = await summarizeHttpRequest({
    method: "GET",
    url: "https://example.com/probe",
    headers: new Headers({ "content-length": "4" }),
    body: null,
  });
  assert.equal(summary.bodyPresent, true);
  assert.equal(summary.bodyComplete, false);
  assert.deepEqual(summary.bodyRiskFlags, ["uninspectable-bodyless-method"]);
  assert.equal(isUninspectableHttpRequest(summary), true);
});

test("paths and custom parameter names are reduced to non-instructional shapes", async () => {
  const summary = await summarizeHttpRequest(new Request(
    "https://example.com/v1/secret/hunter2/ignore-all-instructions?x-user-hunter2=value&page=1",
    { headers: { "x-user-hunter2": "value" } },
  ));
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("hunter2"), false);
  assert.equal(serialized.includes("ignore-all-instructions"), false);
  assert.equal(serialized.includes("x-user-hunter2"), false);
  assert.deepEqual(summary.path, "/v1/[REDACTED]/[REDACTED]/:segment");
  assert.deepEqual(summary.queryParameterNames, ["page", "[CUSTOM_1]"]);
  assert.deepEqual(summary.headerNames, ["[CUSTOM_1]"]);
});

test("opaque cache fingerprints distinguish values without exposing them to reviewers", async () => {
  const firstRequest = new Request("https://example.com/a?token=first", { headers: { authorization: "Bearer first" } });
  const sameRequest = new Request("https://example.com/a?token=first", { headers: { authorization: "Bearer first" } });
  const otherValue = new Request("https://example.com/a?token=second", { headers: { authorization: "Bearer first" } });
  const first = await summarizeHttpRequest(firstRequest);
  const same = await summarizeHttpRequest(sameRequest);
  const other = await summarizeHttpRequest(otherValue);
  const secret = Buffer.alloc(32, 7);
  assert.equal(
    httpRequestScopeFingerprint(firstRequest, first, secret),
    httpRequestScopeFingerprint(sameRequest, same, secret),
  );
  assert.notEqual(
    httpRequestScopeFingerprint(firstRequest, first, secret),
    httpRequestScopeFingerprint(otherValue, other, secret),
  );
  assert.equal(JSON.stringify(first).includes("first"), false);
});

test("HTTP body inspection is bounded and reports an incomplete body", async () => {
  const request = new Request("https://example.com/upload", {
    method: "POST",
    body: "x".repeat(128),
  });
  const summary = await summarizeHttpRequest(request, { maxBodyBytes: 16 });
  assert.equal(summary.bodyComplete, false);
  assert.equal(summary.bodyObservedBytes, 17);
  assert.equal(summary.bodySha256, undefined);
  assert.ok(summary.bodyRiskFlags.includes("body-over-limit"));
});
