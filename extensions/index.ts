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
import {
  hardenSandboxSettings,
  isPublicNetworkDestination,
  runReactiveSandbox,
} from "../src/reactive-sandbox.ts";
import {
  invokeModelReviewer,
  invokeNetworkReviewer,
} from "../src/reviewer.ts";
import type {
  ReviewAssessment,
  ReviewerConfig,
  ReviewRequest,
} from "../src/types.ts";

interface PiPermExtension {
  state: { cwd: string; config: unknown; activeProfile: string };
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

interface ApprovedReview {
  request: ReviewRequest;
  configGeneration: number;
  inputDigest: string;
  cwd: string;
  policy?: string;
  reviewer?: ReviewerConfig;
  assessment?: ReviewAssessment;
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
  const { getActiveProfile } = (await import(
    "pi-perm/" + "core/config.ts"
  )) as { getActiveProfile(state: unknown): unknown };
  const { toSrtSettings } = (await import(
    "pi-perm/" + "core/srt.ts"
  )) as {
    toSrtSettings(profile: unknown): Record<string, unknown>;
  };
  let permissions: PiPermExtension;
  try {
    permissions = piPermModule.createPiPermExtension({
      cwd: process.cwd(),
      events: pi.events,
      // Bash execution uses the bundled SRT library worker below, not pi-perm's
      // external `srt` CLI spawn hook.
      commandExists: () => true,
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
  const approvedReviews = new Map<string, ApprovedReview>();
  let activeSandboxWorkers = 0;
  const rememberApproval = (
    toolCallId: string,
    approval: Omit<ApprovedReview, "configGeneration">,
  ) => {
    if (approvedReviews.has(toolCallId)) return false;
    approvedReviews.set(toolCallId, { ...approval, configGeneration });
    setTimeout(() => approvedReviews.delete(toolCallId), 5 * 60_000).unref();
    return true;
  };

  const bashTool = createBashToolDefinition(permissions.state.cwd);
  pi.registerTool({
    ...bashTool,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      if (activeSandboxWorkers >= 4) {
        throw new Error("reactive sandbox worker limit reached");
      }
      const approved = approvedReviews.get(toolCallId);
      approvedReviews.delete(toolCallId);
      if (
        approved &&
        (approved.inputDigest !== JSON.stringify(params) ||
          approved.cwd !== ctx.cwd ||
          approved.configGeneration !== configGeneration)
      ) {
        throw new Error("permission approval no longer matches this bash invocation");
      }
      const invocationTool = createBashToolDefinition(permissions.state.cwd, {
        operations: {
          exec: (command, cwd, options) =>
            runReactiveSandbox({
              toolCallId,
              command,
              cwd,
              settings: hardenSandboxSettings(
                toSrtSettings(getActiveProfile(permissions.state)),
              ),
              onData: options.onData,
              onNetworkRequest: (destination, reviewSignal) =>
                reviewNetworkRequest(
                  approved,
                  destination,
                  ctx,
                  reviewSignal,
                  configGeneration,
                ),
              ...(options.signal ? { signal: options.signal } : {}),
              ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
            }),
        },
      });
      activeSandboxWorkers += 1;
      try {
        return await invocationTool.execute(
          toolCallId,
          params,
          signal,
          onUpdate,
          ctx,
        );
      } finally {
        approvedReviews.delete(toolCallId);
        activeSandboxWorkers -= 1;
      }
    },
  });

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
      return humanReview(event, request, ctx, undefined, () => {
        rememberApproval(event.toolCallId, {
          request,
          inputDigest: JSON.stringify(event.input),
          cwd: ctx.cwd,
          policy: loaded.config.policy,
        });
      });
    }
    const reviewConfig = loaded;
    const reviewGeneration = configGeneration;
    if (!reviewConfig.valid) {
      return humanReview(
        event,
        request,
        ctx,
        "Reviewer configuration is invalid; automatic approval is disabled",
        () =>
          rememberApproval(event.toolCallId, {
            request,
            inputDigest: JSON.stringify(event.input),
            cwd: ctx.cwd,
          }),
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
        () =>
          rememberApproval(event.toolCallId, {
            request,
            inputDigest: JSON.stringify(event.input),
            cwd: ctx.cwd,
          }),
      );
    }
    if (reviewed.decision === "allow") {
      const decided = [...reviewed.attempts]
        .reverse()
        .find(
          (attempt) =>
            attempt.status === "decided" &&
            attempt.assessment?.decision === "allow",
      );
      const reviewer = decided
        ? reviewConfig.config.reviewers.find(
            (candidate) =>
              candidate.level === decided.level && candidate.model === decided.model,
          )
        : undefined;
      const locked = lockAllowedInput(event, "Approved");
      if (locked) return locked;
      rememberApproval(event.toolCallId, {
        request,
        inputDigest: JSON.stringify(event.input),
        cwd: ctx.cwd,
        policy: reviewConfig.config.policy,
        ...(reviewer ? { reviewer } : {}),
        ...(decided?.assessment ? { assessment: decided.assessment } : {}),
      });
      return;
    }
    if (reviewed.decision === "deny") {
      return { block: true, reason: reviewed.reason, terminate: true };
    }
    return humanReview(event, request, ctx, reviewed.reason, () => {
      rememberApproval(event.toolCallId, {
        request,
        inputDigest: JSON.stringify(event.input),
        cwd: ctx.cwd,
        policy: reviewConfig.config.policy,
      });
    });
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
  onAllow?: () => void,
) {
  if (!ctx.hasUI) {
    return { block: true, reason: `Human approval required: ${reason}` };
  }
  const allowed = await ctx.ui.confirm(
    "Permission review",
    `${reason}\n\nExact ${request.tool} input:\n${formatHumanInput(request.input)}\n\nAllow once?`,
  );
  if (!allowed) return { block: true, reason: "Denied by user", terminate: true };
  const locked = lockAllowedInput(event, "Approved");
  if (locked) return locked;
  onAllow?.();
  return;
}

async function reviewNetworkRequest(
  approved: ApprovedReview | undefined,
  destination: { host: string; port?: number },
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  currentConfigGeneration: number,
): Promise<boolean> {
  if (!approved || signal?.aborted) return false;
  if (!isEligibleReactiveDestination(destination)) return false;
  let reason = "The approved process requested an off-list network destination";
  if (approved.configGeneration !== currentConfigGeneration) {
    reason = "Reviewer configuration changed after the command was approved";
  } else if (approved.reviewer && approved.assessment) {
    const result = await invokeNetworkReviewer(
      ctx.modelRegistry,
      approved.reviewer,
      approved.request,
      approved.assessment,
      destination,
      approved.policy,
      signal,
    );
    if (result.kind === "assessment") {
      if (result.assessment.decision === "allow") return true;
      if (result.assessment.decision === "deny") return false;
      reason = result.assessment.reason;
    } else {
      reason = result.error;
    }
  }
  if (!ctx.hasUI || signal?.aborted) return false;
  return ctx.ui.confirm(
    "Network permission",
    `${reason}\n\nCommand:\n${String(approved.request.input.command ?? "")}\n\nDestination: ${destination.host}:${destination.port ?? "unknown port"}\n\nAllow this destination for this command?`,
    signal ? { signal } : undefined,
  );
}

export function isEligibleReactiveDestination(destination: {
  host: string;
  port?: number;
}): boolean {
  return destination.port === 443 && isPublicNetworkDestination(destination);
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
