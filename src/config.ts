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

const DEFAULT_CONFIG: PermissionReviewerConfig = { reviewers: [] };

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
  if (value.policy !== undefined && typeof value.policy !== "string") {
    throw new Error("policy must be a string");
  }
  return {
    reviewers,
    ...(value.policy ? { policy: value.policy } : {}),
  };
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
