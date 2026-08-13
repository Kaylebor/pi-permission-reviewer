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
  reviewContext?: ReviewContextConfig;
  reactiveReview?: ReactiveReviewConfig;
}

export type ReactiveReasoning =
  | "inherit"
  | "one-lower"
  | "minimum"
  | ThinkingLevel;

export interface ReactiveReviewConfig {
  reasoning: ReactiveReasoning;
  floor: ThinkingLevel;
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
