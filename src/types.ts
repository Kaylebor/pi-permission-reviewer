import type { ThinkingLevel } from "@earendil-works/pi-ai";

export type ReviewDecision = "allow" | "deny" | "escalate" | "human";

export interface ReviewerConfig {
  level: number;
  model: string;
  reasoning?: ThinkingLevel;
  timeoutMs?: number;
}

export interface PermissionReviewerConfig {
  reviewers: ReviewerConfig[];
  policy?: string;
  /** Path to a trusted local Markdown extension for the Guardian prompt. */
  guardianPromptFile?: string;
  reviewContext?: ReviewContextConfig;
  execution?: ExecutionConfig;
  reactiveReview?: ReactiveReviewConfig;
  boundaryReview?: BoundaryReviewConfig;
}

export interface ExecutionConfig {
  /** Maximum number of contained sandboxes that may execute concurrently. */
  maxConcurrentSandboxes: number;
}

export type ReactiveReasoning =
  | "inherit"
  | "one-lower"
  | "minimum"
  | ThinkingLevel;

export interface ReactiveReviewConfig {
  reasoning: ReactiveReasoning;
  floor: ThinkingLevel;
  /** Experimental request-level inspection for dynamically approved HTTPS. */
  inspection: "destination" | "http-metadata";
  /** Escalation path when the bounded HTTP request body is incomplete. */
  incompleteBodyApproval: "human" | "reviewer";
  /** Lowercase request-header names excluded from request identity matching. */
  requestIdentityIgnoredHeaders: readonly string[];
}

export interface BoundaryReviewConfig {
  /** How an explicit public-key read request is handled. */
  publicKeyRead: "review" | "block";
  /** Enable invocation-local Git fsmonitor compatibility. */
  gitFsmonitor: boolean;
  /** How a reviewable request for Git's SSH agent is handled. */
  gitSshAgent: "review" | "block";
}

export interface ReviewContextConfig {
  mode: "transcript" | "metadata";
  conversationTokens: number;
  toolTokens: number;
  persistence: "command" | "session";
}

export interface ReviewRequest {
  tool: string;
  input: Record<string, unknown>;
  cwd: string;
  minimumLevel: number;
  policyReason?: string;
  directUserInput?: string;
}

export interface ReviewAssessment {
  decision: ReviewDecision;
  reason: string;
  policyRule?: string;
}

export interface ReviewAttempt {
  level: number;
  model: string;
  status: "decided" | "unavailable" | "failure" | "timeout" | "cancelled";
  assessment?: ReviewAssessment;
  error?: string;
}

export interface ReviewChainResult {
  decision: ReviewDecision;
  reason: string;
  attempts: ReviewAttempt[];
}
