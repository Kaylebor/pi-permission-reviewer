import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import * as PiAgent from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyBash } from "../src/classifier.ts";
import { handleConfigCommand } from "../src/config-ui.ts";
import { loadConfig } from "../src/config.ts";
import { lockToolInput } from "../src/input-lock.ts";
import { runReviewLevels } from "../src/levels.ts";
import { invokeModelReviewer } from "../src/reviewer.ts";
import type { ReviewRequest } from "../src/types.ts";

interface PiPermExtension {
  state: { cwd: string };
  handleToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<
    | { block?: boolean; reason?: string; terminate?: boolean }
    | undefined
  >;
  createBashSpawnHook(): Parameters<typeof PiAgent.createBashToolDefinition>[1] extends
    | { spawnHook?: infer Hook }
    | undefined
    ? Hook
    : never;
}

export default async function permissionReviewer(pi: ExtensionAPI) {
  let loaded = loadConfig();
  let configGeneration = 0;
  const piPermRoot = dirname(fileURLToPath(import.meta.resolve("pi-perm/package.json")));
  // pi-perm publishes TypeScript without strict-consumer declarations. Resolve it
  // dynamically so its runtime API remains isolated behind our local contract.
  const piPermModule = (await import(
    "pi-perm/" + "core/extension.ts"
  )) as {
    createPiPermExtension(options: Record<string, unknown>): PiPermExtension;
  };
  let permissions: PiPermExtension;
  try {
    permissions = piPermModule.createPiPermExtension({
      cwd: process.cwd(),
      events: pi.events,
      extensionRoot: piPermRoot,
      runtimeBaseDir:
        process.env.PI_PERMISSION_REVIEWER_RUNTIME_DIR ??
        join(homedir(), ".pi", "agent", "permission-reviewer"),
    });
  } catch (error) {
    const reason = `Permission engine failed to initialize: ${error instanceof Error ? error.message : String(error)}`;
    pi.on("tool_call", () => ({ block: true, reason, terminate: true }));
    pi.on("session_start", (_event, ctx) => ctx.ui.notify(reason, "error"));
    pi.registerCommand("permission-reviewer", {
      description: "Show the permission reviewer initialization error",
      handler: async (_args, ctx) => ctx.ui.notify(reason, "error"),
    });
    return;
  }
  const createBashToolDefinition = PiAgent.createBashToolDefinition;
  let latestDirectUserInput: string | undefined;

  pi.registerTool(
    createBashToolDefinition(permissions.state.cwd, {
      spawnHook: permissions.createBashSpawnHook(),
    }),
  );

  pi.on("input", (event) => {
    if (event.source === "interactive" || event.source === "rpc") {
      latestDirectUserInput = event.text;
    }
  });

  pi.on("session_start", (_event, ctx) => {
    for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
    ctx.ui.notify(
      loaded.config.reviewers.length > 0
        ? `pi-permission-reviewer loaded with ${new Set(loaded.config.reviewers.map(({ level }) => level)).size} review level(s)`
        : "pi-permission-reviewer loaded in human-only mode; run /permission-reviewer configure",
      "info",
    );
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") {
      const permissionDecision = await permissions.handleToolCall(event, ctx);
      if (permissionDecision) return permissionDecision;
      return lockAllowedInput(event, "Permission-approved");
    }
    const command = String((event.input as { command?: unknown }).command ?? "");
    const classification = classifyBash(command);
    if (classification.action === "block") {
      return { block: true, reason: classification.reason, terminate: true };
    }

    let confirmationRequested = false;
    const permissionDecision = await permissions.handleToolCall(event, {
      ...ctx,
      ui: {
        ...ctx.ui,
        confirm: async () => {
          confirmationRequested = true;
          return false;
        },
        select: async () => {
          confirmationRequested = true;
          return undefined;
        },
      },
    } as ExtensionContext);
    if (permissionDecision?.block && !confirmationRequested) {
      return { ...permissionDecision, terminate: true };
    }
    if (!permissionDecision && classification.action === "skip") {
      return lockAllowedInput(event, "Skipped");
    }

    const request: ReviewRequest = {
      tool: event.toolName,
      input: event.input as Record<string, unknown>,
      cwd: ctx.cwd,
      minimumLevel: classification.minimumLevel,
      policyReason: permissionDecision?.reason ?? classification.reason,
      ...(latestDirectUserInput ? { directUserInput: latestDirectUserInput } : {}),
    };

    if (classification.action === "human") {
      return humanReview(event, request, ctx);
    }
    const reviewConfig = loaded;
    const reviewGeneration = configGeneration;
    if (!reviewConfig.valid) {
      return humanReview(
        event,
        request,
        ctx,
        "Reviewer configuration is invalid; automatic approval is disabled",
      );
    }
    const reviewed = await runReviewLevels({
      reviewers: reviewConfig.config.reviewers,
      minimumLevel: request.minimumLevel,
      invoke: (invocation) =>
        invokeModelReviewer(
          ctx.modelRegistry,
          invocation,
          request,
          reviewConfig.config.policy,
          ctx.signal,
        ),
    });
    if (configGeneration !== reviewGeneration) {
      return humanReview(
        event,
        request,
        ctx,
        "Reviewer configuration changed while this action was under review",
      );
    }
    if (reviewed.decision === "allow") {
      return lockAllowedInput(event, "Approved");
    }
    if (reviewed.decision === "deny") {
      return { block: true, reason: reviewed.reason, terminate: true };
    }
    return humanReview(event, request, ctx, reviewed.reason);
  });

  pi.registerCommand("permission-reviewer", {
    description: "Inspect or configure the tiered permission reviewer",
    getArgumentCompletions: (prefix) => {
      const commands = ["status", "configure", "models", "reload"];
      const matches = commands.filter((command) => command.startsWith(prefix));
      return matches.length > 0
        ? matches.map((command) => ({ value: command, label: command }))
        : null;
    },
    handler: async (args, ctx) =>
      handleConfigCommand(args, ctx, {
        getLoaded: () => loaded,
        setLoaded: (next) => {
          loaded = next;
          configGeneration += 1;
        },
      }),
  });
}

async function humanReview(
  event: ToolCallEvent,
  request: ReviewRequest,
  ctx: ExtensionContext,
  reason = request.policyReason ?? "model review requires human judgment",
) {
  if (!ctx.hasUI) {
    return { block: true, reason: `Human approval required: ${reason}` };
  }
  const allowed = await ctx.ui.confirm(
    "Permission review",
    `${reason}\n\nExact ${request.tool} input:\n${formatHumanInput(request.input)}\n\nAllow once?`,
  );
  if (!allowed) return { block: true, reason: "Denied by user", terminate: true };
  return lockAllowedInput(event, "Approved");
}

function formatHumanInput(input: Record<string, unknown>): string {
  const rendered = JSON.stringify(input, null, 2);
  const limit = 8_000;
  return rendered.length <= limit
    ? rendered
    : `${rendered.slice(0, limit)}\n[truncated; deny and inspect the complete action before approving]`;
}

function lockAllowedInput(event: ToolCallEvent, label: string) {
  try {
    lockToolInput(event);
    return;
  } catch (error) {
    return {
      block: true,
      reason: `${label} input could not be locked: ${error instanceof Error ? error.message : String(error)}`,
      terminate: true,
    };
  }
}
