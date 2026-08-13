import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import * as PiAgent from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ApprovalStore,
  canonicalSha256,
  createReviewCase,
} from "../src/approval-store.ts";
import { classifyBash } from "../src/classifier.ts";
import { handleConfigCommand } from "../src/config-ui.ts";
import {
  DEFAULT_REACTIVE_REVIEW,
  DEFAULT_REVIEW_CONTEXT,
  loadConfig,
} from "../src/config.ts";
import { ContextLedger, type ReviewContextEvidence } from "../src/context-ledger.ts";
import { lockToolInput } from "../src/input-lock.ts";
import { runReviewLevels } from "../src/levels.ts";
import {
  isPublicNetworkDestination,
  runReactiveSandbox,
} from "../src/reactive-sandbox.ts";
import { createPiPermAdapter } from "../src/pi-perm-adapter.ts";
import {
  createReviewerTranscript,
  invokeModelReviewer,
  invokeNetworkReviewer,
  transcriptRetainsEvidence,
  type ReviewerTranscript,
} from "../src/reviewer.ts";
import type { ApprovalCapability, NetworkDecision, ReviewCase } from "../src/review-types.ts";
import type {
  ReviewerConfig,
  ReactiveReviewConfig,
  ReviewRequest,
} from "../src/types.ts";
import type { ThinkingLevel } from "@earendil-works/pi-ai";

export default async function permissionReviewer(pi: ExtensionAPI) {
  let loaded = loadConfig();
  let configGeneration = 0;
  let sessionEpoch = 0;
  let reviewerLifecycle = new AbortController();
  const contextLedger = new ContextLedger();
  const approvals = new ApprovalStore();
  const reviewerTranscripts = new Map<string, ReviewerTranscript>();
  const reviewerQueues = new Map<string, Promise<void>>();
  const caseEvidence = new Map<string, ReviewContextEvidence>();
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
    pi.on("tool_call", () => ({ block: true, reason }));
    pi.on("session_start", (_event, ctx) => ctx.ui.notify(reason, "error"));
    pi.registerCommand("permission-reviewer", {
      description: "Show the permission reviewer initialization error",
      handler: async (_args, ctx) => ctx.ui.notify(reason, "error"),
    });
    return;
  }
  const createBashToolDefinition = PiAgent.createBashToolDefinition;
  let activeSandboxWorkers = 0;

  const bashTool = createBashToolDefinition(permissions.initialCwd);
  pi.registerTool({
    ...bashTool,
    promptGuidelines: [
      ...(bashTool.promptGuidelines ?? []),
      "Network connections may pause for permission review. Avoid short application-level wall-clock timeouts (for example curl --max-time), or leave those application-level deadlines enough review headroom when redirects or new hosts are possible.",
    ],
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
                  loaded.config.reviewers,
                  loaded.config.reactiveReview ?? DEFAULT_REACTIVE_REVIEW,
                  caseEvidence.get(capability.reviewCase.id),
                  loaded.config.reviewContext?.persistence ?? "command",
                  reviewerTranscripts,
                  reviewerQueues,
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
        caseEvidence.delete(capability.reviewCase.id);
        if ((loaded.config.reviewContext?.persistence ?? "command") === "command") {
          deleteCaseTranscripts(reviewerTranscripts, capability.reviewCase.id);
        }
        activeSandboxWorkers -= 1;
      }
    },
  });

  pi.on("context", (event) => {
    contextLedger.captureContext(event.messages);
  });
  pi.on("message_end", (event) => {
    contextLedger.captureMessageEnd(event.message);
  });

  pi.on("session_start", async (_event, ctx) => {
    sessionEpoch += 1;
    reviewerLifecycle.abort(new Error("Pi session changed"));
    reviewerLifecycle = new AbortController();
    contextLedger.clear();
    reviewerTranscripts.clear();
    reviewerQueues.clear();
    caseEvidence.clear();
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
    reviewerLifecycle.abort(new Error("Pi session ended"));
    reviewerLifecycle = new AbortController();
    contextLedger.clear();
    reviewerTranscripts.clear();
    reviewerQueues.clear();
    caseEvidence.clear();
    approvals.clearAll();
    for (const controller of activeExecutions.values()) controller.abort();
    activeExecutions.clear();
    await permissions.resetSession();
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" && !isReviewableFileTool(event.toolName)) {
      const permissionDecision = await permissions.handleToolCall(event, ctx);
      if (permissionDecision) return permissionDecision;
      return lockAllowedInput(event, "Permission-approved");
    }
    if (isReviewableFileTool(event.toolName)) {
      const fileToolName = event.toolName;
      const ownershipError = validateBuiltinFileToolOwnership(pi, fileToolName);
      if (ownershipError) return blockToolCall(ownershipError);
      const fileSessionEpoch = sessionEpoch;
      const fileConfigGeneration = configGeneration;
      let initialInputDigest: string;
      try {
        initialInputDigest = canonicalSha256(event.input);
      } catch (error) {
        return blockToolCall(
          `File-tool input could not be snapshotted: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const inspected = await permissions.inspectToolCall(event, ctx);
      const boundaryError = validateFileReviewBoundary({
        event,
        initialInputDigest,
        expectedSessionEpoch: fileSessionEpoch,
        expectedConfigGeneration: fileConfigGeneration,
        currentSessionEpoch: sessionEpoch,
        currentConfigGeneration: configGeneration,
        signal: ctx.signal,
        ownershipError: validateBuiltinFileToolOwnership(pi, fileToolName),
      });
      if (boundaryError) return blockToolCall(boundaryError);
      if (inspected.kind === "block") {
        return inspected.decision;
      }
      if (inspected.kind === "allow") {
        return lockAllowedInput(event, "Permission-approved");
      }
      const confirmationLock = lockAllowedInput(event, "Review-pending");
      if (confirmationLock) return confirmationLock;

      const request: ReviewRequest = {
        tool: event.toolName,
        input: event.input as Record<string, unknown>,
        cwd: ctx.cwd,
        minimumLevel: event.toolName === "read" ? 0 : 1,
        policyReason: inspected.reason,
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
          policyReason: request.policyReason,
          ...(loaded.config.policy ? { policy: loaded.config.policy } : {}),
          // File tools use Pi's built-in executors, not the SRT-backed bash
          // executor. Retain a stable, empty execution snapshot for the
          // immutable review-case schema without suggesting an SRT guarantee.
          sandboxSettings: {},
        });
      } catch (error) {
        return blockToolCall(`Could not snapshot the permission boundary: ${error instanceof Error ? error.message : String(error)}`);
      }
      const reviewConfig = loaded;
      const reviewGeneration = configGeneration;
      const reviewSignal = ctx.signal
        ? AbortSignal.any([ctx.signal, reviewerLifecycle.signal])
        : reviewerLifecycle.signal;
      const contextOptions = reviewConfig.config.reviewContext ?? DEFAULT_REVIEW_CONTEXT;
      const evidence = contextLedger.buildEvidence(contextOptions);
      if (!reviewConfig.valid) {
        const result = await humanReview(
          event,
          request,
          ctx,
          "Reviewer configuration is invalid; automatic approval is disabled",
          undefined,
          () => validateFileReviewBoundary({
            event,
            initialInputDigest,
            expectedSessionEpoch: fileSessionEpoch,
            expectedConfigGeneration: fileConfigGeneration,
            currentSessionEpoch: sessionEpoch,
            currentConfigGeneration: configGeneration,
            signal: reviewSignal,
            ownershipError: validateBuiltinFileToolOwnership(pi, fileToolName),
          }),
        );
        return result;
      }
      const reviewed = await runReviewLevels({
        reviewers: reviewConfig.config.reviewers,
        minimumLevel: request.minimumLevel,
        invoke: (invocation) =>
          invokeWithReviewerHistory({
            caseId: reviewCase.id,
            reviewer: invocation.reviewer,
            persistence: contextOptions.persistence,
            transcripts: reviewerTranscripts,
            queues: reviewerQueues,
            invoke: (transcript) => invokeModelReviewer(
              ctx.modelRegistry,
              invocation,
              request,
              reviewConfig.config.policy,
              reviewSignal,
              {
                evidence,
                transcript,
                caseId: reviewCase.id,
                validateBeforeCommit: () => validateFileReviewBoundary({
                  event,
                  initialInputDigest,
                  expectedSessionEpoch: fileSessionEpoch,
                  expectedConfigGeneration: reviewGeneration,
                  currentSessionEpoch: sessionEpoch,
                  currentConfigGeneration: configGeneration,
                  signal: reviewSignal,
                  ownershipError: validateBuiltinFileToolOwnership(pi, fileToolName),
                }),
              },
            ),
          }),
      });
      const postReviewError = validateFileReviewBoundary({
        event,
        initialInputDigest,
        expectedSessionEpoch: fileSessionEpoch,
        expectedConfigGeneration: reviewGeneration,
        currentSessionEpoch: sessionEpoch,
        currentConfigGeneration: configGeneration,
        signal: reviewSignal,
        ownershipError: validateBuiltinFileToolOwnership(pi, fileToolName),
      });
      if (postReviewError) {
        deleteCaseTranscripts(reviewerTranscripts, reviewCase.id);
        return blockToolCall(postReviewError);
      }
      if (reviewed.decision === "allow") {
        deleteCaseTranscripts(reviewerTranscripts, reviewCase.id);
        return lockAllowedInput(event, "Approved");
      }
      if (reviewed.decision === "deny") {
        deleteCaseTranscripts(reviewerTranscripts, reviewCase.id);
        return blockToolCall(reviewed.reason);
      }
      const result = await humanReview(
        event,
        request,
        ctx,
        reviewed.reason,
        undefined,
        () => validateFileReviewBoundary({
          event,
          initialInputDigest,
          expectedSessionEpoch: fileSessionEpoch,
          expectedConfigGeneration: fileConfigGeneration,
          currentSessionEpoch: sessionEpoch,
          currentConfigGeneration: configGeneration,
          signal: reviewSignal,
          ownershipError: validateBuiltinFileToolOwnership(pi, fileToolName),
        }),
      );
      deleteCaseTranscripts(reviewerTranscripts, reviewCase.id);
      return result;
    }
    const command = String((event.input as { command?: unknown }).command ?? "");
    const classification = classifyBash(command);
    if (classification.action === "block") {
      return blockToolCall(classification.reason);
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
      return permissionDecision;
    }
    const request: ReviewRequest = {
      tool: event.toolName,
      input: event.input as Record<string, unknown>,
      cwd: ctx.cwd,
      minimumLevel: classification.minimumLevel,
      policyReason: permissionDecision?.reason ?? classification.reason,
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
      return blockToolCall(`Could not snapshot the permission boundary: ${error instanceof Error ? error.message : String(error)}`);
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
    const reviewSignal = ctx.signal
      ? AbortSignal.any([ctx.signal, reviewerLifecycle.signal])
      : reviewerLifecycle.signal;
    const contextOptions = reviewConfig.config.reviewContext ?? DEFAULT_REVIEW_CONTEXT;
    const evidence = contextLedger.buildEvidence(contextOptions);
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
        invokeWithReviewerHistory({
          caseId: reviewCase.id,
          reviewer: invocation.reviewer,
          persistence: contextOptions.persistence,
          transcripts: reviewerTranscripts,
          queues: reviewerQueues,
          invoke: (transcript) => invokeModelReviewer(
            ctx.modelRegistry,
            invocation,
            request,
            reviewConfig.config.policy,
            reviewSignal,
            { evidence, transcript, caseId: reviewCase.id },
          ),
        }),
    });
    if (configGeneration !== reviewGeneration) {
      const result = await humanReview(
        event,
        request,
        ctx,
        "Reviewer configuration changed while this action was under review",
        () => approvals.remember({ reviewCase, request }),
      );
      if (result?.block) cleanupCaseState(reviewCase.id, reviewerTranscripts, caseEvidence);
      return result;
    }
    if (reviewed.decision === "allow") {
      caseEvidence.set(reviewCase.id, evidence);
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
      const result = allowOnce(event, approvals, {
        reviewCase,
        request,
        ...(reviewer ? { reviewer } : {}),
        ...(decided?.assessment ? { assessment: decided.assessment } : {}),
      }, "Approved");
      if (result?.block) cleanupCaseState(reviewCase.id, reviewerTranscripts, caseEvidence);
      return result;
    }
    if (reviewed.decision === "deny") {
      cleanupCaseState(reviewCase.id, reviewerTranscripts, caseEvidence);
      return blockToolCall(reviewed.reason);
    }
    const result = await humanReview(event, request, ctx, reviewed.reason, () =>
      approvals.remember({ reviewCase, request }));
    if (result?.block) cleanupCaseState(reviewCase.id, reviewerTranscripts, caseEvidence);
    return result;
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
          reviewerLifecycle.abort(new Error("Reviewer configuration changed"));
          reviewerLifecycle = new AbortController();
          reviewerTranscripts.clear();
          reviewerQueues.clear();
          caseEvidence.clear();
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
  validateBeforeAllow?: () => string | undefined,
) {
  if (!ctx.hasUI) {
    return { block: true, reason: `Human approval required: ${reason}` };
  }
  const allowed = await ctx.ui.confirm(
    "Permission review",
    `${reason}\n\nExact ${request.tool} input:\n${formatHumanInput(request.input)}\n\nAllow once?`,
  );
  if (!allowed) return blockToolCall("Denied by user");
  const validationError = validateBeforeAllow?.();
  if (validationError) return blockToolCall(validationError);
  const locked = lockAllowedInput(event, "Approved");
  if (locked) return locked;
  if (onAllow && !onAllow()) {
    return {
      block: true,
      reason: "Approved capability collided with an existing tool call",
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
  reviewers: ReviewerConfig[],
  reactiveReview: ReactiveReviewConfig,
  evidence: ReviewContextEvidence | undefined,
  persistence: "command" | "session",
  transcripts: Map<string, ReviewerTranscript>,
  queues: Map<string, Promise<void>>,
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
    const ordered = orderReactiveReviewers(reviewers, approved.reviewer);
    const resumedWinner = ordered[0];
    const reviewed = await runReviewLevels({
      reviewers: ordered,
      minimumLevel: approved.reviewer.level,
      invoke: (invocation) => invokeWithReviewerHistory({
        caseId,
        reviewer: invocation.reviewer,
        persistence,
        transcripts,
        queues,
        invoke: (transcript) => {
          const resumesWinner = invocation.reviewer === resumedWinner;
          return invokeNetworkReviewer(
            ctx.modelRegistry,
            invocation.reviewer,
            approved.request,
            approved.assessment!,
            destination,
            approved.reviewCase.policy,
            signal,
            {
              // The resumed winner already has this case's original evidence in
              // its local transcript. New fallback/escalation reviewers do not.
              ...(!resumesWinner || !transcriptRetainsEvidence(transcript, caseId)
                ? { evidence }
                : {}),
              transcript,
              caseId,
              ...(resumesWinner
                ? { reasoning: resolveReactiveReasoning(invocation.reviewer, reactiveReview) }
                : {}),
            },
          );
        },
      }),
    });
    if (reviewed.decision === "allow") {
      const winner = [...reviewed.attempts].reverse().find(
        (attempt) => attempt.status === "decided" && attempt.assessment?.decision === "allow",
      );
      return {
        decision: "allow",
        source: "reviewer",
        reason: reviewed.reason,
        caseId,
        ...(winner ? { reviewer: winner.model } : {}),
      };
    }
    if (reviewed.decision === "deny") return deny("reviewer", reviewed.reason);
    reason = reviewed.reason;
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

export function resolveReactiveReasoning(
  reviewer: ReviewerConfig,
  config: ReactiveReviewConfig,
): ThinkingLevel {
  const configured = reviewer.reasoning ?? "low";
  if (config.reasoning === "inherit") return configured;
  if (config.reasoning === "minimum") return "minimal";
  if (config.reasoning !== "one-lower") return config.reasoning;
  const levels: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
  const current = levels.indexOf(configured);
  const floor = levels.indexOf(config.floor);
  if (current <= floor) return configured;
  return levels[Math.max(current - 1, floor)]!;
}

function orderReactiveReviewers(
  reviewers: ReviewerConfig[],
  winner: ReviewerConfig,
): ReviewerConfig[] {
  return [
    winner,
    ...reviewers.filter((reviewer) =>
      reviewer.level >= winner.level && !sameReviewer(reviewer, winner)),
  ];
}

function sameReviewer(left: ReviewerConfig, right: ReviewerConfig): boolean {
  return left.level === right.level &&
    left.model === right.model &&
    (left.reasoning ?? "low") === (right.reasoning ?? "low") &&
    (left.timeoutMs ?? 60_000) === (right.timeoutMs ?? 60_000);
}

async function invokeWithReviewerHistory<T>(options: {
  caseId: string;
  reviewer: ReviewerConfig;
  persistence: "command" | "session";
  transcripts: Map<string, ReviewerTranscript>;
  queues: Map<string, Promise<void>>;
  invoke(transcript: ReviewerTranscript): Promise<T>;
}): Promise<T> {
  const identity = reviewerIdentity(options.reviewer);
  const key = options.persistence === "session"
    ? `session:${identity}`
    : `case:${options.caseId}:${identity}`;
  const transcript = options.transcripts.get(key) ?? createReviewerTranscript();
  options.transcripts.set(key, transcript);
  if (options.persistence === "command") return options.invoke(transcript);
  const previous = options.queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  options.queues.set(key, tail);
  await previous;
  try {
    return await options.invoke(transcript);
  } finally {
    release();
    if (options.queues.get(key) === tail) options.queues.delete(key);
  }
}

function reviewerIdentity(reviewer: ReviewerConfig): string {
  return JSON.stringify({
    model: reviewer.model,
    reasoning: reviewer.reasoning ?? "low",
    timeoutMs: reviewer.timeoutMs ?? 60_000,
  });
}

function deleteCaseTranscripts(
  transcripts: Map<string, ReviewerTranscript>,
  caseId: string,
): void {
  const prefix = `case:${caseId}:`;
  for (const key of transcripts.keys()) {
    if (key.startsWith(prefix)) transcripts.delete(key);
  }
}

function cleanupCaseState(
  caseId: string,
  transcripts: Map<string, ReviewerTranscript>,
  evidence: Map<string, ReviewContextEvidence>,
): void {
  deleteCaseTranscripts(transcripts, caseId);
  evidence.delete(caseId);
}

export function isEligibleReactiveDestination(destination: {
  host: string;
  port?: number;
}): boolean {
  return destination.port === 443 && isPublicNetworkDestination(destination);
}

function isReviewableFileTool(toolName: string): toolName is "read" | "write" | "edit" {
  return toolName === "read" || toolName === "write" || toolName === "edit";
}

function validateBuiltinFileToolOwnership(
  pi: ExtensionAPI,
  toolName: "read" | "write" | "edit",
): string | undefined {
  try {
    const tool = pi.getAllTools().find((candidate) => candidate.name === toolName);
    if (tool?.sourceInfo.source === "builtin") return;
    return `Cannot review ${toolName}: Pi's effective ${toolName} tool is not the built-in executor`;
  } catch (error) {
    return `Cannot verify Pi's effective ${toolName} executor: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function validateFileReviewBoundary(options: {
  event: ToolCallEvent;
  initialInputDigest: string;
  expectedSessionEpoch: number;
  expectedConfigGeneration: number;
  currentSessionEpoch: number;
  currentConfigGeneration: number;
  signal?: AbortSignal;
  ownershipError?: string;
}): string | undefined {
  if (options.ownershipError) return options.ownershipError;
  if (options.signal?.aborted) {
    return "File operation was cancelled while under review";
  }
  if (options.currentSessionEpoch !== options.expectedSessionEpoch) {
    return "Pi session changed while this file operation was under review";
  }
  if (options.currentConfigGeneration !== options.expectedConfigGeneration) {
    return "Reviewer configuration changed while this file operation was under review";
  }
  try {
    if (canonicalSha256(options.event.input) !== options.initialInputDigest) {
      return "File-tool input changed while this operation was under review";
    }
  } catch (error) {
    return `File-tool input could not be revalidated: ${error instanceof Error ? error.message : String(error)}`;
  }
  return;
}

function blockToolCall(reason: string) {
  return { block: true, reason };
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
    };
  }
  return;
}
