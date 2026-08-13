import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  handleConfigCommand,
  listSelectableModels,
} from "../src/config-ui.ts";
import { loadConfig } from "../src/config.ts";

const model = (provider: string, id: string) => ({ provider, id });

test("model picker honors Pi's scoped models", () => {
  const scoped = model("ollama", "deepseek-v4");
  const registry = {
    getAvailable: () => [model("openai-codex", "gpt-5.6-luna")],
    hasConfiguredAuth: () => true,
  };
  assert.deepEqual(
    listSelectableModels({
      scopedModels: [{ model: scoped }],
      modelRegistry: registry,
    } as any),
    ["ollama/deepseek-v4"],
  );
});

test("configure UI adds a provider-neutral reviewer and updates live state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-permission-reviewer-ui-"));
  const path = join(directory, "config.json");
  const previous = process.env.PI_PERMISSION_REVIEWER_CONFIG;
  process.env.PI_PERMISSION_REVIEWER_CONFIG = path;
  let loaded = loadConfig(path);
  const selections = [
    "Add a reviewer",
    "0 — routine or simple unknown actions",
    "ollama/deepseek-v4",
    "low",
    "30 seconds",
  ];
  try {
    await handleConfigCommand(
      "configure",
      {
        hasUI: true,
        scopedModels: [],
        modelRegistry: {
          getAvailable: () => [model("ollama", "deepseek-v4")],
          hasConfiguredAuth: () => true,
        },
        ui: {
          select: async () => selections.shift(),
          input: async () => undefined,
          editor: async () => undefined,
          confirm: async () => false,
          notify() {},
        },
      } as any,
      {
        getLoaded: () => loaded,
        setLoaded: (next) => {
          loaded = next;
        },
      },
    );
    assert.deepEqual(loaded.config.reviewers, [
      {
        level: 0,
        model: "ollama/deepseek-v4",
        reasoning: "low",
        timeoutMs: 30_000,
      },
    ]);
    assert.deepEqual(loadConfig(path).config, loaded.config);
  } finally {
    if (previous === undefined) delete process.env.PI_PERMISSION_REVIEWER_CONFIG;
    else process.env.PI_PERMISSION_REVIEWER_CONFIG = previous;
  }
});

test("configure UI exposes context detail, budgets, and persistence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-permission-reviewer-ui-"));
  const path = join(directory, "config.json");
  const previous = process.env.PI_PERMISSION_REVIEWER_CONFIG;
  process.env.PI_PERMISSION_REVIEWER_CONFIG = path;
  let loaded = loadConfig(path);
  const selections = [
    "Configure review context",
    "metadata — aggregate counts only",
    "session — serialized reviewer trunk for the Pi session",
  ];
  const inputs = ["1200", "600"];
  try {
    await handleConfigCommand(
      "configure",
      {
        hasUI: true,
        scopedModels: [],
        modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => false },
        ui: {
          select: async () => selections.shift(),
          input: async () => inputs.shift(),
          editor: async () => undefined,
          confirm: async () => false,
          notify() {},
        },
      } as any,
      {
        getLoaded: () => loaded,
        setLoaded: (next) => { loaded = next; },
      },
    );
    assert.deepEqual(loaded.config.reviewContext, {
      mode: "metadata",
      persistence: "session",
      conversationTokens: 1200,
      toolTokens: 600,
    });
  } finally {
    if (previous === undefined) delete process.env.PI_PERMISSION_REVIEWER_CONFIG;
    else process.env.PI_PERMISSION_REVIEWER_CONFIG = previous;
  }
});
