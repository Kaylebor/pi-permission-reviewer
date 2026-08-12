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
