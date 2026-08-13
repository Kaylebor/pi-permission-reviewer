import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  handleConfigCommand,
  listSelectableModels,
} from "../src/config-ui.ts";
import { loadConfig, saveConfig, saveGuardianPrompt } from "../src/config.ts";

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

test("configure UI exposes resumed-winner reasoning reduction", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-permission-reviewer-ui-"));
  const path = join(directory, "config.json");
  const previous = process.env.PI_PERMISSION_REVIEWER_CONFIG;
  process.env.PI_PERMISSION_REVIEWER_CONFIG = path;
  let loaded = loadConfig(path);
  const selections = [
    "Configure reactive review",
    "one-lower — reduce one step, then use the configured floor",
    "low",
  ];
  try {
    await handleConfigCommand(
      "configure",
      {
        hasUI: true,
        scopedModels: [],
        modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => false },
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
        setLoaded: (next) => { loaded = next; },
      },
    );
    assert.deepEqual(loaded.config.reactiveReview, {
      reasoning: "one-lower",
      floor: "low",
    });
  } finally {
    if (previous === undefined) delete process.env.PI_PERMISSION_REVIEWER_CONFIG;
    else process.env.PI_PERMISSION_REVIEWER_CONFIG = previous;
  }
});

test("Guardian prompt editor saves the configured Markdown and status only reports its source", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-permission-reviewer-ui-"));
  const path = join(directory, "config.json");
  const previous = process.env.PI_PERMISSION_REVIEWER_CONFIG;
  process.env.PI_PERMISSION_REVIEWER_CONFIG = path;
  let loaded = loadConfig(path);
  const selections = ["Edit Guardian prompt"];
  const notices: string[] = [];
  try {
    await handleConfigCommand(
      "configure",
      {
        hasUI: true,
        scopedModels: [],
        modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => false },
        ui: {
          select: async () => selections.shift(),
          input: async () => undefined,
          editor: async (title: string, current: string) => {
            assert.match(title, /permission-reviewer\.guardian\.md/);
            assert.equal(current, "");
            return "Escalate unclear effects.\n";
          },
          confirm: async () => false,
          notify(message: string) { notices.push(message); },
        },
      } as any,
      {
        getLoaded: () => loaded,
        setLoaded: (next) => { loaded = next; },
      },
    );
    assert.equal(loaded.config.guardianPromptFile, "permission-reviewer.guardian.md");
    assert.equal(loaded.guardianPrompt, "Escalate unclear effects.\n");
    await handleConfigCommand(
      "status",
      {
        hasUI: true,
        scopedModels: [],
        modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => false },
        ui: { notify(message: string) { notices.push(message); } },
      } as any,
      { getLoaded: () => loaded, setLoaded() {} },
    );
    assert.match(notices.at(-1) ?? "", /Guardian prompt: .*permission-reviewer\.guardian\.md/);
    assert.doesNotMatch(notices.at(-1) ?? "", /Escalate unclear effects/);
  } finally {
    if (previous === undefined) delete process.env.PI_PERMISSION_REVIEWER_CONFIG;
    else process.env.PI_PERMISSION_REVIEWER_CONFIG = previous;
  }
});

test("Guardian prompt editor preserves a custom prompt path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-permission-reviewer-ui-"));
  const path = join(directory, "config.json");
  const promptPath = join(directory, "custom.md");
  const previous = process.env.PI_PERMISSION_REVIEWER_CONFIG;
  process.env.PI_PERMISSION_REVIEWER_CONFIG = path;
  saveGuardianPrompt("Existing local guidance.\n", promptPath);
  let loaded = saveConfig({ reviewers: [], guardianPromptFile: "custom.md" }, path);
  const selections = ["Edit Guardian prompt"];
  try {
    await handleConfigCommand(
      "configure",
      {
        hasUI: true,
        scopedModels: [],
        modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => false },
        ui: {
          select: async () => selections.shift(),
          input: async () => undefined,
          editor: async (_title: string, current: string) => {
            assert.equal(current, "Existing local guidance.\n");
            return "Updated local guidance.\n";
          },
          confirm: async () => false,
          notify() {},
        },
      } as any,
      {
        getLoaded: () => loaded,
        setLoaded: (next) => { loaded = next; },
      },
    );
    assert.equal(loaded.config.guardianPromptFile, "custom.md");
    assert.equal(readFileSync(promptPath, "utf8"), "Updated local guidance.\n");
  } finally {
    if (previous === undefined) delete process.env.PI_PERMISSION_REVIEWER_CONFIG;
    else process.env.PI_PERMISSION_REVIEWER_CONFIG = previous;
  }
});

test("Guardian prompt editor realigns live state when config persistence fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-permission-reviewer-ui-"));
  const path = join(directory, "config.json");
  const promptPath = join(directory, "custom.md");
  const previous = process.env.PI_PERMISSION_REVIEWER_CONFIG;
  process.env.PI_PERMISSION_REVIEWER_CONFIG = path;
  saveGuardianPrompt("Old guidance.\n", promptPath);
  let loaded = saveConfig({ reviewers: [], guardianPromptFile: "custom.md" }, path);
  rmSync(path);
  mkdirSync(path);
  const notices: string[] = [];
  try {
    await handleConfigCommand(
      "configure",
      {
        hasUI: true,
        scopedModels: [],
        modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => false },
        ui: {
          select: async () => "Edit Guardian prompt",
          input: async () => undefined,
          editor: async () => "New guidance.\n",
          confirm: async () => false,
          notify(message: string) { notices.push(message); },
        },
      } as any,
      {
        getLoaded: () => loaded,
        setLoaded: (next) => { loaded = next; },
      },
    );
    assert.equal(readFileSync(promptPath, "utf8"), "New guidance.\n");
    assert.equal(loaded.valid, false);
    assert.equal(loaded.guardianPrompt, undefined);
    assert.match(notices.at(-1) ?? "", /Configuration not saved/);
  } finally {
    if (previous === undefined) delete process.env.PI_PERMISSION_REVIEWER_CONFIG;
    else process.env.PI_PERMISSION_REVIEWER_CONFIG = previous;
  }
});
