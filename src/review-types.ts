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

export type BoundaryKind =
  | "network-destination"
  | "filesystem-read"
  | "public-key-read"
  | "filesystem-write"
  | "unix-socket"
  | "ssh-agent";

export interface BoundaryRequest {
  kind: BoundaryKind;
  resource: string;
  phase: "preflight" | "reactive";
  reason: string;
  platform?: NodeJS.Platform;
}

export interface ApprovalCapability {
  reviewCase: ReviewCase;
  request: ReviewRequest;
  reviewer?: ReviewerConfig;
  assessment?: ReviewAssessment;
  /** Environment values exposed only to this one approved invocation. */
  executionEnvironment?: Readonly<Record<string, string>>;
  boundaries?: readonly Readonly<BoundaryRequest>[];
}
