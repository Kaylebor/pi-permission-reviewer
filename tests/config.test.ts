import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, validateConfig } from "../src/config.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
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
