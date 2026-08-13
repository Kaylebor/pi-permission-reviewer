import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import * as PiAgent from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { ApprovalStore, createReviewCase } from "../src/approval-store.ts";
import { classifyBash } from "../src/classifier.ts";
import { handleConfigCommand } from "../src/config-ui.ts";
import { loadConfig } from "../src/config.ts";
import { lockToolInput } from "../src/input-lock.ts";
import { runReviewLevels } from "../src/levels.ts";
import {
  isPublicNetworkDestination,
  runReactiveSandbox,
} from "../src/reactive-sandbox.ts";
import { createPiPermAdapter } from "../src/pi-perm-adapter.ts";
import {
  invokeModelReviewer,
  invokeNetworkReviewer,
} from "../src/reviewer.ts";
import type { ApprovalCapability, NetworkDecision, ReviewCase } from "../src/review-types.ts";
import type {
  ReviewerConfig,
  ReviewRequest,
} from "../src/types.ts";

export default async function permissionReviewer(pi: ExtensionAPI) {
  let loaded = loadConfig();
  let configGeneration = 0;
  let sessionEpoch = 0;
  const approvals = new ApprovalStore();
  const activeExecutions = new Map<string, AbortController>();
  const permissions = await createPiPermAdapter({
    cwd: process.cwd(),
    events: pi.events,
    commandExists: () => true,
    runtimeBaseDir:
      process.env.PI_PERMISSION_REVIEWER_RUNTIME_DIR ??
      join(homedir(), ".pi", "agent", "permission-reviewer"),
  });
  if (permissions.initializationError) {
    const reason = permissions.initializationError;
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
  let activeSandboxWorkers = 0;

  const bashTool = createBashToolDefinition(permissions.initialCwd);
  pi.registerTool({
    ...bashTool,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      if (activeSandboxWorkers >= 4) {
        throw new Error("reactive sandbox worker limit reached");
      }
      const consumed = approvals.consume({
        toolCallId,
        tool: "bash",
        input: params,
        cwd: ctx.cwd,
        configGeneration,
        sessionEpoch,
      });
      if (!consumed.ok) {
        throw new Error(`bash execution lacks a valid one-use approval capability (${consumed.reason})`);
      }
      const capability = consumed.capability;
      const executionController = new AbortController();
      activeExecutions.set(toolCallId, executionController);
      const combinedSignal = signal
        ? AbortSignal.any([signal, executionController.signal])
        : executionController.signal;
      const invocationTool = createBashToolDefinition(capability.reviewCase.cwd, {
        operations: {
          exec: (command, cwd, options) =>
            runReactiveSandbox({
              toolCallId,
              caseId: capability.reviewCase.id,
              command,
              cwd,
              settings: capability.reviewCase.sandboxSettings as Record<string, unknown>,
              onData: options.onData,
              onNetworkRequest: (destination, reviewSignal) =>
                reviewNetworkRequest(
                  capability,
                  destination,
                  ctx,
                  reviewSignal,
                  configGeneration,
                ),
              onNetworkDecision: (decision, destination) => {
                if (decision.decision === "deny") {
                  const detail = `[permission-reviewer] denied ${destination.host}:${destination.port ?? "?"} (${decision.source}): ${decision.reason}\n`;
                  options.onData(Buffer.from(detail));
                  if (ctx.hasUI) ctx.ui.notify(detail.trim(), "warning");
                }
              },
              signal: options.signal
                ? AbortSignal.any([options.signal, combinedSignal])
                : combinedSignal,
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
        activeExecutions.delete(toolCallId);
        activeSandboxWorkers -= 1;
      }
    },
  });

  pi.on("input", (event) => {
    if (event.source === "interactive" || event.source === "rpc") {
      latestDirectUserInput = event.text;
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    sessionEpoch += 1;
    latestDirectUserInput = undefined;
    approvals.clearAll();
    for (const controller of activeExecutions.values()) controller.abort();
    activeExecutions.clear();
    await permissions.resetSession();
    for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
    ctx.ui.notify(
      loaded.config.reviewers.length > 0
        ? `pi-permission-reviewer loaded with ${new Set(loaded.config.reviewers.map(({ level }) => level)).size} review level(s)`
        : "pi-permission-reviewer loaded in human-only mode; run /permission-reviewer configure",
      "info",
    );
  });

  pi.on("session_shutdown", async () => {
    sessionEpoch += 1;
    latestDirectUserInput = undefined;
    approvals.clearAll();
    for (const controller of activeExecutions.values()) controller.abort();
    activeExecutions.clear();
    await permissions.resetSession();
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
    const request: ReviewRequest = {
      tool: event.toolName,
      input: event.input as Record<string, unknown>,
      cwd: ctx.cwd,
      minimumLevel: classification.minimumLevel,
      policyReason: permissionDecision?.reason ?? classification.reason,
      ...(latestDirectUserInput ? { directUserInput: latestDirectUserInput } : {}),
    };
    let reviewCase: ReviewCase;
    try {
      reviewCase = createReviewCase({
        sessionEpoch,
        configGeneration,
        toolCallId: event.toolCallId,
        tool: event.toolName,
        input: event.input as Record<string, unknown>,
        cwd: ctx.cwd,
        minimumLevel: request.minimumLevel,
        ...(request.policyReason ? { policyReason: request.policyReason } : {}),
        ...(request.directUserInput ? { directUserInput: request.directUserInput } : {}),
        ...(loaded.config.policy ? { policy: loaded.config.policy } : {}),
        sandboxSettings: await permissions.getHardenedSrtSettings(ctx.cwd),
      });
    } catch (error) {
      return { block: true, reason: `Could not snapshot the permission boundary: ${error instanceof Error ? error.message : String(error)}`, terminate: true };
    }
    if (!permissionDecision && classification.action === "skip") {
      return allowOnce(event, approvals, { reviewCase, request }, "Skipped");
    }

    if (classification.action === "human") {
      return humanReview(event, request, ctx, undefined, () =>
        approvals.remember({ reviewCase, request }));
    }
    const reviewConfig = loaded;
    const reviewGeneration = configGeneration;
    if (!reviewConfig.valid) {
      return humanReview(
        event,
        request,
        ctx,
        "Reviewer configuration is invalid; automatic approval is disabled",
        () => approvals.remember({ reviewCase, request }),
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
        () => approvals.remember({ reviewCase, request }),
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
      return allowOnce(event, approvals, {
        reviewCase,
        request,
        ...(reviewer ? { reviewer } : {}),
        ...(decided?.assessment ? { assessment: decided.assessment } : {}),
      }, "Approved");
    }
    if (reviewed.decision === "deny") {
      return { block: true, reason: reviewed.reason, terminate: true };
    }
    return humanReview(event, request, ctx, reviewed.reason, () =>
      approvals.remember({ reviewCase, request }));
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
          approvals.clearAll();
          for (const controller of activeExecutions.values()) controller.abort();
        },
      }),
  });
}

async function humanReview(
  event: ToolCallEvent,
  request: ReviewRequest,
  ctx: ExtensionContext,
  reason = request.policyReason ?? "model review requires human judgment",
  onAllow?: () => boolean,
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
  if (onAllow && !onAllow()) {
    return {
      block: true,
      reason: "Approved capability collided with an existing tool call",
      terminate: true,
    };
  }
  return;
}

async function reviewNetworkRequest(
  approved: ApprovalCapability,
  destination: { host: string; port?: number },
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  currentConfigGeneration: number,
): Promise<NetworkDecision> {
  const caseId = approved.reviewCase.id;
  const deny = (source: NetworkDecision["source"], reason: string): NetworkDecision =>
    ({ decision: "deny", source, reason, caseId });
  if (signal?.aborted) return deny("cancelled", "network review cancelled");
  if (!isEligibleReactiveDestination(destination)) {
    return deny("eligibility", "destination is not eligible for reactive approval");
  }
  let reason = "The approved process requested an off-list network destination";
  if (approved.reviewCase.configGeneration !== currentConfigGeneration) {
    reason = "Reviewer configuration changed after the command was approved";
  } else if (approved.reviewer && approved.assessment) {
    const result = await invokeNetworkReviewer(
      ctx.modelRegistry,
      approved.reviewer,
      approved.request,
      approved.assessment,
      destination,
      approved.reviewCase.policy,
      signal,
    );
    if (result.kind === "assessment") {
      if (result.assessment.decision === "allow") {
        return {
          decision: "allow",
          source: "reviewer",
          reason: result.assessment.reason,
          caseId,
          reviewer: approved.reviewer.model,
        };
      }
      if (result.assessment.decision === "deny") {
        return deny("reviewer", result.assessment.reason);
      }
      reason = result.assessment.reason;
    } else {
      reason = result.error;
    }
  }
  if (!ctx.hasUI || signal?.aborted) return deny("human", reason);
  const allowed = await ctx.ui.confirm(
    "Network permission",
    `${reason}\n\nCommand:\n${String(approved.request.input.command ?? "")}\n\nDestination: ${destination.host}:${destination.port ?? "unknown port"}\n\nAllow this destination for this command?`,
    signal ? { signal } : undefined,
  );
  return {
    decision: allowed ? "allow" : "deny",
    source: "human",
    reason: allowed ? "destination approved by user" : "destination denied by user",
    caseId,
  };
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

function allowOnce(
  event: ToolCallEvent,
  approvals: ApprovalStore,
  capability: ApprovalCapability,
  label: string,
) {
  const locked = lockAllowedInput(event, label);
  if (locked) return locked;
  if (!approvals.remember(capability)) {
    return {
      block: true,
      reason: `${label} capability collided with an existing tool call`,
      terminate: true,
    };
  }
  return;
}
