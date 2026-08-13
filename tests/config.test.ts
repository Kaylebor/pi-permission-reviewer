import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultGuardianPromptPath,
  loadConfig,
  resolveGuardianPromptPath,
  saveConfig,
  saveGuardianPrompt,
  validateConfig,
} from "../src/config.ts";
import { mkdtempSync, readFileSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

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
  assert.deepEqual(config.boundaryReview, {
    gitFsmonitor: true,
    gitSshAgent: "review",
  });
});

test("validates boundary review settings and fills their safe defaults", () => {
  const config = validateConfig({
    reviewers: [],
    boundaryReview: { gitSshAgent: "block" },
  });
  assert.deepEqual(config.boundaryReview, {
    gitFsmonitor: true,
    gitSshAgent: "block",
  });
  assert.throws(
    () => validateConfig({ reviewers: [], boundaryReview: { gitFsmonitor: 1 } }),
    /boundaryReview\.gitFsmonitor must be a boolean/,
  );
  assert.throws(
    () => validateConfig({ reviewers: [], boundaryReview: { gitSshAgent: "allow" } }),
    /boundaryReview\.gitSshAgent must be review or block/,
  );
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

test("validates and resolves trusted Guardian prompt file paths", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-permission-reviewer-"));
  const configPath = join(directory, "config.json");
  const config = validateConfig({
    reviewers: [],
    guardianPromptFile: "prompts/guardian.md",
  });
  assert.equal(config.guardianPromptFile, "prompts/guardian.md");
  assert.equal(
    resolveGuardianPromptPath("prompts/guardian.md", configPath),
    join(directory, "prompts", "guardian.md"),
  );
  assert.equal(
    resolveGuardianPromptPath("~/guardian.md", configPath),
    join(homedir(), "guardian.md"),
  );
  assert.equal(
    resolveGuardianPromptPath(join(directory, "absolute.md"), configPath),
    join(directory, "absolute.md"),
  );
  assert.equal(defaultGuardianPromptPath(), join(homedir(), ".pi", "agent", "permission-reviewer.guardian.md"));
  assert.throws(
    () => validateConfig({ reviewers: [], guardianPromptFile: "guardian.txt" }),
    /non-empty .md filename/,
  );
  assert.throws(
    () => validateConfig({ reviewers: [], guardianPromptFile: ".md" }),
    /non-empty .md filename/,
  );
  assert.throws(
    () => validateConfig({ reviewers: [], guardianPromptFile: "guardian.md\0backup" }),
    /must not contain NUL/,
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

test("loads a configured Guardian prompt and fails closed when it is unavailable", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-permission-reviewer-"));
  const path = join(directory, "config.json");
  const promptPath = join(directory, "guardian.md");
  writeFileSync(promptPath, "Treat this as trusted policy.\n");
  writeFileSync(path, JSON.stringify({
    reviewers: [{ level: 0, model: "provider/fast" }],
    guardianPromptFile: "guardian.md",
  }));
  const loaded = loadConfig(path);
  assert.equal(loaded.valid, true);
  assert.equal(loaded.guardianPrompt, "Treat this as trusted policy.\n");
  assert.equal(loaded.guardianPromptSource, promptPath);

  writeFileSync(promptPath, Buffer.alloc(32 * 1024 + 1, "a"));
  const oversized = loadConfig(path);
  assert.equal(oversized.valid, false);
  assert.deepEqual(oversized.config.reviewers, [{ level: 0, model: "provider/fast" }]);
  assert.match(oversized.warnings[0], /must not exceed 32768 UTF-8 bytes/);

  truncateSync(promptPath, 1024 ** 4);
  const sparseOversized = loadConfig(path);
  assert.equal(sparseOversized.valid, false);
  assert.match(sparseOversized.warnings[0], /must not exceed 32768 UTF-8 bytes/);

  writeFileSync(path, JSON.stringify({ reviewers: [], guardianPromptFile: "missing.md" }));
  const missing = loadConfig(path);
  assert.equal(missing.valid, false);
  assert.deepEqual(missing.config.reviewers, []);
  assert.match(missing.warnings[0], /Guardian prompt could not be loaded/);

  writeFileSync(promptPath, Buffer.from([0xc3, 0x28]));
  writeFileSync(path, JSON.stringify({ reviewers: [], guardianPromptFile: "guardian.md" }));
  const malformed = loadConfig(path);
  assert.equal(malformed.valid, false);
  assert.match(malformed.warnings[0], /Guardian prompt could not be loaded/);
});

test("rejects a configured Guardian prompt that is not a regular file", {
  skip: process.platform === "win32",
}, () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-permission-reviewer-"));
  const promptPath = join(directory, "guardian.md");
  const linkPath = join(directory, "linked.md");
  writeFileSync(promptPath, "trusted");
  symlinkSync(promptPath, linkPath);
  const configPath = join(directory, "config.json");
  writeFileSync(configPath, JSON.stringify({ reviewers: [], guardianPromptFile: "linked.md" }));
  const loaded = loadConfig(configPath);
  assert.equal(loaded.valid, false);
  assert.match(loaded.warnings[0], /regular file/);

  const fifoPath = join(directory, "named-pipe.md");
  execFileSync("mkfifo", [fifoPath]);
  writeFileSync(configPath, JSON.stringify({ reviewers: [], guardianPromptFile: "named-pipe.md" }));
  const fifo = loadConfig(configPath);
  assert.equal(fifo.valid, false);
  assert.match(fifo.warnings[0], /regular file/);
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

test("saves a private Guardian prompt and immediately reloads its trusted text", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-permission-reviewer-"));
  const path = join(directory, "config.json");
  const promptPath = join(directory, "guardian.md");
  saveGuardianPrompt("Only approve bounded actions.\n", promptPath);
  const loaded = saveConfig({ reviewers: [], guardianPromptFile: "guardian.md" }, path);
  assert.equal(loaded.guardianPrompt, "Only approve bounded actions.\n");
  assert.equal(loaded.guardianPromptSource, promptPath);
  if (process.platform !== "win32") {
    assert.equal(statSync(promptPath).mode & 0o777, 0o600);
  }
  assert.throws(
    () => saveGuardianPrompt("a".repeat(32 * 1024 + 1), promptPath),
    /must not exceed 32768 UTF-8 bytes/,
  );
  assert.equal(readFileSync(promptPath, "utf8"), "Only approve bounded actions.\n");
});
