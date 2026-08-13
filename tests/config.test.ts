import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, saveConfig, validateConfig } from "../src/config.ts";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("accepts tied and sparse reviewer levels", () => {
  const config = validateConfig({
    reviewers: [
      { level: 0, model: "a/fast" },
      { level: 0, model: "b/fast" },
      { level: 10, model: "c/deep" },
    ],
  });
  assert.deepEqual(config.reviewers.map(({ level }) => level), [0, 0, 10]);
  assert.deepEqual(config.reviewContext, {
    mode: "transcript",
    conversationTokens: 4_000,
    toolTokens: 2_000,
    persistence: "command",
  });
  assert.deepEqual(config.reactiveReview, {
    reasoning: "one-lower",
    floor: "low",
  });
});

test("validates provider-neutral review context settings", () => {
  const config = validateConfig({
    reviewers: [],
    reviewContext: {
      mode: "metadata",
      conversationTokens: 1200,
      toolTokens: 600,
      persistence: "session",
    },
  });
  assert.equal(config.reviewContext?.persistence, "session");
  assert.throws(
    () => validateConfig({ reviewers: [], reviewContext: { mode: "raw" } }),
    /mode must be transcript or metadata/,
  );
});

test("validates reactive continuation reasoning", () => {
  const config = validateConfig({
    reviewers: [],
    reactiveReview: { reasoning: "inherit", floor: "minimal" },
  });
  assert.deepEqual(config.reactiveReview, {
    reasoning: "inherit",
    floor: "minimal",
  });
  assert.throws(
    () => validateConfig({ reviewers: [], reactiveReview: { reasoning: "cheapest" } }),
    /reactiveReview\.reasoning is invalid/,
  );
});

test("supports Pi max reasoning and rejects ambiguous reviewer identities", () => {
  const config = validateConfig({
    reviewers: [{ level: 0, model: "provider/model", reasoning: "max" }],
    reactiveReview: { reasoning: "one-lower", floor: "max" },
  });
  assert.equal(config.reviewers[0].reasoning, "max");
  assert.equal(config.reactiveReview?.floor, "max");
  assert.throws(
    () => validateConfig({
      reviewers: [
        { level: 0, model: "provider/model", reasoning: "low" },
        { level: 0, model: "provider/model", reasoning: "high" },
      ],
    }),
    /duplicate reviewer level\/model/,
  );
});

test("rejects malformed model specs", () => {
  assert.throws(
    () => validateConfig({ reviewers: [{ level: 0, model: "missing-slash" }] }),
    /provider\/model/,
  );
});

test("invalid stored config disables automatic approval", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-permission-reviewer-"));
  const path = join(directory, "config.json");
  writeFileSync(path, "{not-json");
  const loaded = loadConfig(path);
  assert.equal(loaded.valid, false);
  assert.equal(loaded.warnings.length, 1);
});

test("missing config is provider-neutral and human-only", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-permission-reviewer-"));
  const loaded = loadConfig(join(directory, "missing.json"));
  assert.deepEqual(loaded.config.reviewers, []);
  assert.equal(loaded.source, undefined);
  assert.equal(loaded.valid, true);
});

test("saves validated configuration atomically with private permissions", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-permission-reviewer-"));
  const path = join(directory, "config.json");
  const loaded = saveConfig(
    { reviewers: [{ level: 0, model: "provider/fast" }] },
    path,
  );
  assert.equal(loaded.source, path);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), loaded.config);
  if (process.platform !== "win32") {
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
});
