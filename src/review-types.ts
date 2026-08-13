import type { ReviewAssessment, ReviewerConfig, ReviewRequest } from "./types.ts";

export type NetworkDecisionSource =
  | "eligibility"
  | "policy"
  | "reviewer"
  | "human"
  | "timeout"
  | "cancelled"
  | "error"
  | "limit";

export interface NetworkDecision {
  decision: "allow" | "deny";
  source: NetworkDecisionSource;
  reason: string;
  caseId: string;
  reviewer?: string;
}

export interface ReviewCase {
  id: string;
  sessionEpoch: number;
  configGeneration: number;
  toolCallId: string;
  tool: string;
  input: Readonly<Record<string, unknown>>;
  inputDigest: string;
  cwd: string;
  minimumLevel: number;
  policyReason?: string;
  directUserInput?: string;
  policy?: string;
  guardianPrompt?: string;
  sandboxSettings: Readonly<Record<string, unknown>>;
}

export interface ApprovalCapability {
  reviewCase: ReviewCase;
  request: ReviewRequest;
  reviewer?: ReviewerConfig;
  assessment?: ReviewAssessment;
}
