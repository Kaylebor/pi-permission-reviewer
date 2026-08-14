import assert from "node:assert/strict";
import test from "node:test";
import {
  httpRequestScopeFingerprint,
  isUninspectableHttpRequest,
  normalizeIgnoredHttpHeaders,
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

test("declared GET bodies are marked uninspectable for parent review", async () => {
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

test("valid request IDs and trace headers normalize only in the opaque cache identity", async () => {
  const firstRequest = new Request("https://example.com/resource", {
    headers: {
      "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      "x-request-id": "9b7c5ca5-6d93-4b23-a6fc-7e6758303b67",
    },
  });
  const secondRequest = new Request("https://example.com/resource", {
    headers: {
      "traceparent": "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      "x-request-id": "6d9488c0-438d-49c4-90b8-6da5b6f1b1ef",
    },
  });
  const malformedRequest = new Request("https://example.com/resource", {
    headers: { "x-request-id": "not-a-valid-request-id" },
  });
  const otherMalformedRequest = new Request("https://example.com/resource", {
    headers: { "x-request-id": "a-different-invalid-value" },
  });
  const secret = Buffer.alloc(32, 5);
  assert.equal(
    httpRequestScopeFingerprint(firstRequest, await summarizeHttpRequest(firstRequest), secret),
    httpRequestScopeFingerprint(secondRequest, await summarizeHttpRequest(secondRequest), secret),
  );
  assert.notEqual(
    httpRequestScopeFingerprint(malformedRequest, await summarizeHttpRequest(malformedRequest), secret),
    httpRequestScopeFingerprint(otherMalformedRequest, await summarizeHttpRequest(otherMalformedRequest), secret),
  );
});

test("configured ignored headers never remove credentials, authority, or framing from identity", async () => {
  const firstRequest = new Request("https://example.com/resource", {
    headers: { "x-deployment-id": "first", authorization: "Bearer one" },
  });
  const secondRequest = new Request("https://example.com/resource", {
    headers: { "x-deployment-id": "second", authorization: "Bearer one" },
  });
  const secret = Buffer.alloc(32, 9);
  const first = await summarizeHttpRequest(firstRequest);
  const second = await summarizeHttpRequest(secondRequest);
  assert.equal(
    httpRequestScopeFingerprint(firstRequest, first, secret, { ignoredHeaders: ["x-deployment-id"] }),
    httpRequestScopeFingerprint(secondRequest, second, secret, { ignoredHeaders: ["x-deployment-id"] }),
  );
  assert.throws(() => normalizeIgnoredHttpHeaders(["authorization"]), /protected/);
  assert.throws(() => normalizeIgnoredHttpHeaders(["host"]), /protected/);
  assert.throws(() => normalizeIgnoredHttpHeaders(["content-length"]), /protected/);
  assert.throws(() => normalizeIgnoredHttpHeaders(["expect"]), /protected/);
});
