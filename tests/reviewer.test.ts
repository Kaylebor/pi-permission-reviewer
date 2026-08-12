import assert from "node:assert/strict";
import test from "node:test";
import { parseAssessment } from "../src/reviewer.ts";

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
