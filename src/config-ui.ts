import type {
  ExtensionCommandContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { basename } from "node:path";
import {
  defaultGuardianPromptPath,
  defaultConfigPath,
  loadConfig,
  parseModelSpec,
  resolveGuardianPromptPath,
  saveConfig,
  saveGuardianPrompt,
  validateConfig,
  type LoadedConfig,
} from "./config.ts";
import type {
  PermissionReviewerConfig,
  ReviewerConfig,
} from "./types.ts";

type ConfigContext = Pick<
  ExtensionCommandContext,
  "hasUI" | "scopedModels" | "modelRegistry" | "ui"
>;

export interface ConfigCommandOptions {
  getLoaded(): LoadedConfig;
  setLoaded(loaded: LoadedConfig): void;
}

const ACTIONS = [
  "Add a reviewer",
  "Remove a reviewer",
  "Move a tied reviewer",
  "Configure review context",
  "Configure reactive review",
  "Configure boundary review",
  "Edit policy",
  "Edit Guardian prompt",
  "Edit JSON (advanced)",
] as const;

export async function handleConfigCommand(
  args: string,
  ctx: ConfigContext,
  options: ConfigCommandOptions,
): Promise<void> {
  const subcommand = args.trim().toLowerCase() || "menu";
  if (subcommand === "status") return showStatus(ctx, options.getLoaded());
  if (subcommand === "models") return showModels(ctx);
  if (subcommand === "reload") {
    const loaded = (await import("./config.ts")).loadConfig();
    options.setLoaded(loaded);
    ctx.ui.notify(
      loaded.valid ? "Permission reviewer configuration reloaded" : loaded.warnings[0],
      loaded.valid ? "info" : "error",
    );
    return;
  }
  if (subcommand !== "menu" && subcommand !== "configure") {
    ctx.ui.notify(
      "Usage: /permission-reviewer [status|configure|models|reload]",
      "warning",
    );
    return;
  }
  if (!ctx.hasUI) {
    showStatus(ctx, options.getLoaded());
    return;
  }
  const action = await ctx.ui.select("Permission reviewer configuration", [
    "Show status",
    ...ACTIONS,
  ]);
  if (!action) return;
  if (action === "Show status") return showStatus(ctx, options.getLoaded());
  if (action === "Add a reviewer") return addReviewer(ctx, options);
  if (action === "Remove a reviewer") return removeReviewer(ctx, options);
  if (action === "Move a tied reviewer") return moveReviewer(ctx, options);
  if (action === "Configure review context") return configureReviewContext(ctx, options);
  if (action === "Configure reactive review") return configureReactiveReview(ctx, options);
  if (action === "Configure boundary review") return configureBoundaryReview(ctx, options);
  if (action === "Edit policy") return editPolicy(ctx, options);
  if (action === "Edit Guardian prompt") return editGuardianPrompt(ctx, options);
  return editJson(ctx, options);
}

export function listSelectableModels(
  ctx: Pick<ConfigContext, "scopedModels" | "modelRegistry">,
): string[] {
  const candidates =
    ctx.scopedModels.length > 0
      ? ctx.scopedModels.map(({ model }) => model)
      : ctx.modelRegistry.getAvailable();
  return modelSpecs(candidates, ctx.modelRegistry);
}

function modelSpecs(
  models: readonly Model<any>[],
  registry: ModelRegistry,
): string[] {
  return [
    ...new Set(
      models
        .filter((model) => registry.hasConfiguredAuth(model))
        .map((model) => `${model.provider}/${model.id}`),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function showStatus(ctx: Pick<ConfigContext, "ui">, loaded: LoadedConfig): void {
  const reviewContext = loaded.config.reviewContext ?? {
    mode: "transcript",
    conversationTokens: 4_000,
    toolTokens: 2_000,
    persistence: "command",
  };
  const reviewers = loaded.config.reviewers.map(
    (reviewer, index) =>
      `${index + 1}. level ${reviewer.level}: ${reviewer.model} (${reviewer.reasoning ?? "low"}, ${reviewer.timeoutMs ?? 60_000}ms)`,
  );
  const reactiveReview = loaded.config.reactiveReview ?? {
    reasoning: "one-lower",
    floor: "low",
  };
  const boundaryReview = loaded.config.boundaryReview ?? {
    publicKeyRead: "review",
    gitFsmonitor: true,
    gitSshAgent: "review",
  };
  ctx.ui.notify(
    [
      `Config: ${loaded.source ?? "not created"}`,
      `Mode: ${loaded.valid && reviewers.length > 0 ? "model review, then human" : "human-only"}`,
      ...(reviewers.length > 0 ? reviewers : ["Reviewers: none"]),
      `Policy: ${loaded.config.policy ?? "default reviewer policy"}`,
      `Guardian prompt: ${loaded.guardianPromptSource ?? "built-in"}`,
      `Context: ${reviewContext.mode}, ${reviewContext.conversationTokens} conversation tokens + ${reviewContext.toolTokens} tool tokens, ${reviewContext.persistence} persistence`,
      `Reactive review: ${reactiveReview.reasoning}${reactiveReview.reasoning === "one-lower" ? ` (floor ${reactiveReview.floor})` : ""}`,
      `Boundary review: public-key reads ${boundaryReview.publicKeyRead}, Git fsmonitor ${boundaryReview.gitFsmonitor ? "enabled" : "disabled"}, Git SSH agent ${boundaryReview.gitSshAgent}`,
    ].join("\n"),
    loaded.valid ? "info" : "error",
  );
}

async function configureBoundaryReview(
  ctx: ConfigContext,
  options: ConfigCommandOptions,
): Promise<void> {
  const loaded = options.getLoaded();
  const current = loaded.config.boundaryReview ?? {
    publicKeyRead: "review" as const,
    gitFsmonitor: true,
    gitSshAgent: "review" as const,
  };
  const publicKeyRead = await ctx.ui.select("Public-key read boundary", [
    "review — send an explicit public-key read request to the reviewer chain",
    "block — deny public-key read access deterministically",
  ]);
  if (!publicKeyRead) return;
  const gitFsmonitor = await ctx.ui.select("Git fsmonitor boundary", [
    "enabled — exact macOS socket or invocation-local Linux disable",
    "disabled — do not add Git fsmonitor compatibility",
  ]);
  if (!gitFsmonitor) return;
  const gitSshAgent = await ctx.ui.select("Git SSH agent boundary", [
    "review — send a Git SSH agent request to the reviewer chain",
    "block — deny Git SSH agent access deterministically",
  ]);
  if (!gitSshAgent) return;
  persist(ctx, options, {
    ...loaded.config,
    boundaryReview: {
      ...current,
      publicKeyRead: publicKeyRead.startsWith("review") ? "review" : "block",
      gitFsmonitor: gitFsmonitor.startsWith("enabled"),
      gitSshAgent: gitSshAgent.startsWith("review") ? "review" : "block",
    },
  });
}

async function configureReactiveReview(
  ctx: ConfigContext,
  options: ConfigCommandOptions,
): Promise<void> {
  const loaded = options.getLoaded();
  const reasoning = await ctx.ui.select("Resumed winner reasoning", [
    "one-lower — reduce one step, then use the configured floor",
    "inherit — keep the winner's configured effort",
    "minimum — use minimal effort",
    "minimal — explicit minimal effort",
    "low — explicit low effort",
    "medium — explicit medium effort",
    "high — explicit high effort",
    "xhigh — explicit xhigh effort",
    "max — explicit max effort",
  ]);
  if (!reasoning) return;
  let floor = loaded.config.reactiveReview?.floor ?? "low";
  if (reasoning.startsWith("one-lower")) {
    const selectedFloor = await ctx.ui.select("One-step reduction floor", [
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    if (!selectedFloor) return;
    floor = selectedFloor as NonNullable<PermissionReviewerConfig["reactiveReview"]>["floor"];
  }
  persist(ctx, options, {
    ...loaded.config,
    reactiveReview: {
      reasoning: reasoning.split(" ", 1)[0] as NonNullable<PermissionReviewerConfig["reactiveReview"]>["reasoning"],
      floor,
    },
  });
}

async function showModels(ctx: ConfigContext): Promise<void> {
  const models = listSelectableModels(ctx);
  if (models.length === 0) {
    ctx.ui.notify(
      "No authenticated models are available in the current Pi model scope",
      "warning",
    );
    return;
  }
  if (ctx.hasUI) {
    await ctx.ui.select(
      ctx.scopedModels.length > 0 ? "Scoped authenticated models" : "Authenticated models",
      models,
    );
    return;
  }
  ctx.ui.notify(models.join("\n"), "info");
}

async function addReviewer(
  ctx: ConfigContext,
  options: ConfigCommandOptions,
): Promise<void> {
  const levelChoice = await ctx.ui.select("Minimum review level", [
    "0 — routine or simple unknown actions",
    "1 — complex shell actions",
    "2 — stronger optional escalation",
    "Custom level",
  ]);
  if (!levelChoice) return;
  let level = Number.parseInt(levelChoice, 10);
  if (levelChoice === "Custom level") {
    const value = await ctx.ui.input("Reviewer level", "non-negative integer");
    if (value === undefined) return;
    level = Number(value);
  }
  if (!Number.isSafeInteger(level) || level < 0) {
    ctx.ui.notify("Level must be a non-negative integer", "error");
    return;
  }

  const models = listSelectableModels(ctx);
  const manual = "Enter provider/model manually";
  const selection = await ctx.ui.select("Reviewer model", [...models, manual]);
  if (!selection) return;
  const model =
    selection === manual
      ? await ctx.ui.input("Reviewer model", "provider/model")
      : selection;
  if (!model) return;
  if (!parseModelSpec(model)) {
    ctx.ui.notify("Model must use Pi's provider/model identifier", "error");
    return;
  }

  const reasoning = await ctx.ui.select("Reviewer reasoning effort", [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  if (!reasoning) return;
  const timeout = await ctx.ui.select("Reviewer timeout", [
    "30 seconds",
    "60 seconds",
    "120 seconds",
  ]);
  if (!timeout) return;
  const reviewer: ReviewerConfig = {
    level,
    model,
    reasoning: reasoning as ReviewerConfig["reasoning"],
    timeoutMs: Number.parseInt(timeout, 10) * 1_000,
  };
  persist(ctx, options, {
    ...options.getLoaded().config,
    reviewers: [...options.getLoaded().config.reviewers, reviewer],
  });
}

async function removeReviewer(
  ctx: ConfigContext,
  options: ConfigCommandOptions,
): Promise<void> {
  const loaded = options.getLoaded();
  const picked = await pickReviewer(
    ctx,
    loaded.config.reviewers,
    "Remove reviewer",
  );
  if (picked === undefined) return;
  const reviewer = loaded.config.reviewers[picked];
  if (
    !(await ctx.ui.confirm(
      "Remove reviewer",
      `Remove level ${reviewer.level} ${reviewer.model}?`,
    ))
  )
    return;
  persist(ctx, options, {
    ...loaded.config,
    reviewers: loaded.config.reviewers.filter((_reviewer, index) => index !== picked),
  });
}

async function moveReviewer(
  ctx: ConfigContext,
  options: ConfigCommandOptions,
): Promise<void> {
  const loaded = options.getLoaded();
  const picked = await pickReviewer(
    ctx,
    loaded.config.reviewers,
    "Move tied reviewer",
  );
  if (picked === undefined) return;
  const direction = await ctx.ui.select("Tie-break order", ["Move earlier", "Move later"]);
  if (!direction) return;
  const offset = direction === "Move earlier" ? -1 : 1;
  const target = picked + offset;
  if (
    target < 0 ||
    target >= loaded.config.reviewers.length ||
    loaded.config.reviewers[target].level !== loaded.config.reviewers[picked].level
  ) {
    ctx.ui.notify(
      "A reviewer can only move past another reviewer at the same level",
      "warning",
    );
    return;
  }
  const reviewers = [...loaded.config.reviewers];
  [reviewers[picked], reviewers[target]] = [reviewers[target], reviewers[picked]];
  persist(ctx, options, { ...loaded.config, reviewers });
}

async function editPolicy(
  ctx: ConfigContext,
  options: ConfigCommandOptions,
): Promise<void> {
  const loaded = options.getLoaded();
  const policy = await ctx.ui.editor(
    "Additional reviewer policy",
    loaded.config.policy ?? "",
  );
  if (policy === undefined) return;
  persist(ctx, options, {
    ...loaded.config,
    ...(policy.trim() ? { policy: policy.trim() } : {}),
  });
}

async function editGuardianPrompt(
  ctx: ConfigContext,
  options: ConfigCommandOptions,
): Promise<void> {
  const loaded = options.getLoaded();
  const guardianPromptFile =
    loaded.config.guardianPromptFile ?? basename(defaultGuardianPromptPath());
  const guardianPromptPath = resolveGuardianPromptPath(
    guardianPromptFile,
    loaded.source ?? defaultConfigPath(),
  );
  const prompt = await ctx.ui.editor(
    `Edit Guardian prompt (${guardianPromptPath})`,
    loaded.guardianPrompt ?? "",
  );
  if (prompt === undefined) return;
  try {
    saveGuardianPrompt(prompt, guardianPromptPath);
    persist(ctx, options, { ...loaded.config, guardianPromptFile });
  } catch (error) {
    ctx.ui.notify(
      `Guardian prompt not saved: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

async function configureReviewContext(
  ctx: ConfigContext,
  options: ConfigCommandOptions,
): Promise<void> {
  const loaded = options.getLoaded();
  const current = loaded.config.reviewContext ?? {
    mode: "transcript" as const,
    conversationTokens: 4_000,
    toolTokens: 2_000,
    persistence: "command" as const,
  };
  const mode = await ctx.ui.select("Reviewer context detail", [
    "transcript — bounded redacted conversation text",
    "metadata — aggregate counts only",
  ]);
  if (!mode) return;
  const persistence = await ctx.ui.select("Reviewer history persistence", [
    "command — isolated history per permission case",
    "session — serialized reviewer trunk for the Pi session",
  ]);
  if (!persistence) return;
  const conversation = await ctx.ui.input(
    "Conversation token budget",
    String(current.conversationTokens),
  );
  if (conversation === undefined) return;
  const tools = await ctx.ui.input(
    "Tool-output token budget",
    String(current.toolTokens),
  );
  if (tools === undefined) return;
  persist(ctx, options, {
    ...loaded.config,
    reviewContext: {
      mode: mode.startsWith("transcript") ? "transcript" : "metadata",
      persistence: persistence.startsWith("command") ? "command" : "session",
      conversationTokens: Number(conversation),
      toolTokens: Number(tools),
    },
  });
}

async function editJson(
  ctx: ConfigContext,
  options: ConfigCommandOptions,
): Promise<void> {
  const edited = await ctx.ui.editor(
    `Edit ${defaultConfigPath()}`,
    JSON.stringify(options.getLoaded().config, null, 2),
  );
  if (edited === undefined) return;
  try {
    persist(ctx, options, validateConfig(JSON.parse(edited) as unknown));
  } catch (error) {
    ctx.ui.notify(
      `Configuration not saved: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

async function pickReviewer(
  ctx: ConfigContext,
  reviewers: ReviewerConfig[],
  title: string,
): Promise<number | undefined> {
  if (reviewers.length === 0) {
    ctx.ui.notify("No reviewers are configured", "warning");
    return;
  }
  const labels = reviewers.map(
    (reviewer, index) => `${index + 1}. level ${reviewer.level} — ${reviewer.model}`,
  );
  const picked = await ctx.ui.select(title, labels);
  return picked ? labels.indexOf(picked) : undefined;
}

function persist(
  ctx: Pick<ConfigContext, "ui">,
  options: ConfigCommandOptions,
  config: PermissionReviewerConfig,
): boolean {
  try {
    const loaded = saveConfig(config);
    options.setLoaded(loaded);
    if (!loaded.valid) {
      ctx.ui.notify(loaded.warnings[0] ?? "Saved configuration is invalid", "error");
      return false;
    }
    ctx.ui.notify(`Saved ${loaded.source}`, "info");
    return true;
  } catch (error) {
    // A related file (notably the Guardian prompt) may already have changed.
    // Reloading invalidates the live generation and keeps disk and memory aligned.
    options.setLoaded(loadConfig());
    ctx.ui.notify(
      `Configuration not saved: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return false;
  }
}
