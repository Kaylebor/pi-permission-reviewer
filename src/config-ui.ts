import type {
  ExtensionCommandContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
  defaultConfigPath,
  parseModelSpec,
  saveConfig,
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
  "Edit policy",
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
  if (action === "Edit policy") return editPolicy(ctx, options);
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
  const reviewers = loaded.config.reviewers.map(
    (reviewer, index) =>
      `${index + 1}. level ${reviewer.level}: ${reviewer.model} (${reviewer.reasoning ?? "low"}, ${reviewer.timeoutMs ?? 60_000}ms)`,
  );
  ctx.ui.notify(
    [
      `Config: ${loaded.source ?? "not created"}`,
      `Mode: ${loaded.valid && reviewers.length > 0 ? "model review, then human" : "human-only"}`,
      ...(reviewers.length > 0 ? reviewers : ["Reviewers: none"]),
      `Policy: ${loaded.config.policy ?? "default reviewer policy"}`,
    ].join("\n"),
    loaded.valid ? "info" : "error",
  );
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
    reviewers: loaded.config.reviewers,
    ...(policy.trim() ? { policy: policy.trim() } : {}),
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
): void {
  try {
    const loaded = saveConfig(config);
    options.setLoaded(loaded);
    ctx.ui.notify(`Saved ${loaded.source}`, "info");
  } catch (error) {
    ctx.ui.notify(
      `Configuration not saved: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}
