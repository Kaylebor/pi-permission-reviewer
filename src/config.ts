import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  PermissionReviewerConfig,
  ReviewerConfig,
} from "./types.ts";

export const DEFAULT_REVIEW_CONTEXT = {
  mode: "transcript",
  conversationTokens: 4_000,
  toolTokens: 2_000,
  persistence: "command",
} as const;
export const DEFAULT_REACTIVE_REVIEW = {
  reasoning: "one-lower",
  floor: "low",
} as const;
const DEFAULT_CONFIG: PermissionReviewerConfig = {
  reviewers: [],
  reviewContext: DEFAULT_REVIEW_CONTEXT,
  reactiveReview: DEFAULT_REACTIVE_REVIEW,
};

export interface LoadedConfig {
  config: PermissionReviewerConfig;
  source?: string;
  warnings: string[];
  valid: boolean;
}

export function loadConfig(path = defaultConfigPath()): LoadedConfig {
  if (!existsSync(path)) {
    return { config: DEFAULT_CONFIG, warnings: [], valid: true };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return { config: validateConfig(raw), source: path, warnings: [], valid: true };
  } catch (error) {
    return {
      config: DEFAULT_CONFIG,
      source: path,
      warnings: [
        `Invalid permission reviewer config; automatic approval is disabled: ${error instanceof Error ? error.message : String(error)}`,
      ],
      valid: false,
    };
  }
}

export function validateConfig(value: unknown): PermissionReviewerConfig {
  if (!isRecord(value)) throw new Error("expected an object");
  if (!Array.isArray(value.reviewers)) {
    throw new Error("reviewers must be an array");
  }
  const reviewers = value.reviewers.map(validateReviewer);
  const reviewerKeys = new Set<string>();
  for (const reviewer of reviewers) {
    const key = `${reviewer.level}\0${reviewer.model}`;
    if (reviewerKeys.has(key)) {
      throw new Error(`duplicate reviewer level/model: level ${reviewer.level} ${reviewer.model}`);
    }
    reviewerKeys.add(key);
  }
  if (value.policy !== undefined && typeof value.policy !== "string") {
    throw new Error("policy must be a string");
  }
  const reviewContext = validateReviewContext(value.reviewContext);
  const reactiveReview = validateReactiveReview(value.reactiveReview);
  return {
    reviewers,
    reviewContext,
    reactiveReview,
    ...(value.policy ? { policy: value.policy } : {}),
  };
}

function validateReactiveReview(value: unknown): NonNullable<PermissionReviewerConfig["reactiveReview"]> {
  if (value === undefined) return { ...DEFAULT_REACTIVE_REVIEW };
  if (!isRecord(value)) throw new Error("reactiveReview must be an object");
  const reasoning = value.reasoning ?? DEFAULT_REACTIVE_REVIEW.reasoning;
  const floor = value.floor ?? DEFAULT_REACTIVE_REVIEW.floor;
  const validReasoning = [
    "inherit",
    "one-lower",
    "minimum",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];
  const validFloors = ["minimal", "low", "medium", "high", "xhigh", "max"];
  if (typeof reasoning !== "string" || !validReasoning.includes(reasoning)) {
    throw new Error("reactiveReview.reasoning is invalid");
  }
  if (typeof floor !== "string" || !validFloors.includes(floor)) {
    throw new Error("reactiveReview.floor is invalid");
  }
  return {
    reasoning: reasoning as NonNullable<PermissionReviewerConfig["reactiveReview"]>["reasoning"],
    floor: floor as NonNullable<PermissionReviewerConfig["reactiveReview"]>["floor"],
  };
}

function validateReviewContext(value: unknown): NonNullable<PermissionReviewerConfig["reviewContext"]> {
  if (value === undefined) return { ...DEFAULT_REVIEW_CONTEXT };
  if (!isRecord(value)) throw new Error("reviewContext must be an object");
  const mode = value.mode ?? DEFAULT_REVIEW_CONTEXT.mode;
  const persistence = value.persistence ?? DEFAULT_REVIEW_CONTEXT.persistence;
  if (mode !== "transcript" && mode !== "metadata") {
    throw new Error("reviewContext.mode must be transcript or metadata");
  }
  if (persistence !== "command" && persistence !== "session") {
    throw new Error("reviewContext.persistence must be command or session");
  }
  const conversationTokens = value.conversationTokens ?? DEFAULT_REVIEW_CONTEXT.conversationTokens;
  const toolTokens = value.toolTokens ?? DEFAULT_REVIEW_CONTEXT.toolTokens;
  for (const [name, tokens] of [["conversationTokens", conversationTokens], ["toolTokens", toolTokens]] as const) {
    if (!Number.isSafeInteger(tokens) || Number(tokens) < 0 || Number(tokens) > 100_000) {
      throw new Error(`reviewContext.${name} must be an integer from 0 to 100000`);
    }
  }
  return { mode, persistence, conversationTokens: Number(conversationTokens), toolTokens: Number(toolTokens) };
}

export function saveConfig(
  config: PermissionReviewerConfig,
  path = defaultConfigPath(),
): LoadedConfig {
  const validated = validateConfig(config);
  const directory = dirname(path);
  const temporary = join(
    directory,
    `.permission-reviewer.${process.pid}.${Date.now()}.tmp`,
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { config: validated, source: path, warnings: [], valid: true };
}

export function defaultConfigPath(): string {
  return (
    process.env.PI_PERMISSION_REVIEWER_CONFIG ??
    join(homedir(), ".pi", "agent", "permission-reviewer.json")
  );
}

function validateReviewer(value: unknown, index: number): ReviewerConfig {
  if (!isRecord(value)) throw new Error(`reviewers[${index}] must be an object`);
  if (!Number.isSafeInteger(value.level) || Number(value.level) < 0) {
    throw new Error(`reviewers[${index}].level must be a non-negative integer`);
  }
  if (typeof value.model !== "string" || !parseModelSpec(value.model)) {
    throw new Error(`reviewers[${index}].model must be provider/model`);
  }
  const validReasoning = ["minimal", "low", "medium", "high", "xhigh", "max"];
  if (
    value.reasoning !== undefined &&
    (typeof value.reasoning !== "string" ||
      !validReasoning.includes(value.reasoning))
  ) {
    throw new Error(`reviewers[${index}].reasoning is invalid`);
  }
  if (
    value.timeoutMs !== undefined &&
    (!Number.isSafeInteger(value.timeoutMs) || Number(value.timeoutMs) < 1_000)
  ) {
    throw new Error(`reviewers[${index}].timeoutMs must be at least 1000`);
  }
  return {
    level: Number(value.level),
    model: value.model,
    ...(value.reasoning
      ? { reasoning: value.reasoning as ReviewerConfig["reasoning"] }
      : {}),
    ...(value.timeoutMs ? { timeoutMs: Number(value.timeoutMs) } : {}),
  };
}

export function parseModelSpec(
  value: string,
): { provider: string; model: string } | undefined {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1 || /\s/.test(value)) return;
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
