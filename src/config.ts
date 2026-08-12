import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  PermissionReviewerConfig,
  ReviewerConfig,
} from "./types.ts";

const DEFAULT_CONFIG: PermissionReviewerConfig = {
  reviewers: [
    {
      level: 0,
      model: "openai-codex/gpt-5.6-luna",
      reasoning: "low",
      timeoutMs: 30_000,
    },
    {
      level: 1,
      model: "openai-codex/gpt-5.6-terra",
      reasoning: "medium",
      timeoutMs: 60_000,
    },
  ],
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
  if (!Array.isArray(value.reviewers) || value.reviewers.length === 0) {
    throw new Error("reviewers must be a non-empty array");
  }
  const reviewers = value.reviewers.map(validateReviewer);
  if (value.policy !== undefined && typeof value.policy !== "string") {
    throw new Error("policy must be a string");
  }
  return {
    reviewers,
    ...(value.policy ? { policy: value.policy } : {}),
  };
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
  const validReasoning = ["minimal", "low", "medium", "high", "xhigh"];
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
