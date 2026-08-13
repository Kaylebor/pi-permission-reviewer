import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
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
export const DEFAULT_BOUNDARY_REVIEW = {
  gitFsmonitor: true,
  gitSshAgent: "review",
} as const;
const DEFAULT_CONFIG: PermissionReviewerConfig = {
  reviewers: [],
  reviewContext: DEFAULT_REVIEW_CONTEXT,
  reactiveReview: DEFAULT_REACTIVE_REVIEW,
  boundaryReview: DEFAULT_BOUNDARY_REVIEW,
};
const MAX_GUARDIAN_PROMPT_BYTES = 32 * 1024;

export interface LoadedConfig {
  config: PermissionReviewerConfig;
  source?: string;
  guardianPrompt?: string;
  guardianPromptSource?: string;
  warnings: string[];
  valid: boolean;
}

export function loadConfig(path = defaultConfigPath()): LoadedConfig {
  if (!existsSync(path)) {
    return { config: DEFAULT_CONFIG, warnings: [], valid: true };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const config = validateConfig(raw);
    if (!config.guardianPromptFile) {
      return { config, source: path, warnings: [], valid: true };
    }
    const guardianPromptSource = resolveGuardianPromptPath(config.guardianPromptFile, path);
    try {
      return {
        config,
        source: path,
        guardianPrompt: loadGuardianPrompt(guardianPromptSource),
        guardianPromptSource,
        warnings: [],
        valid: true,
      };
    } catch (error) {
      return {
        config,
        source: path,
        guardianPromptSource,
        warnings: [
          `Guardian prompt could not be loaded; automatic approval is disabled: ${error instanceof Error ? error.message : String(error)}`,
        ],
        valid: false,
      };
    }
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
  const boundaryReview = validateBoundaryReview(value.boundaryReview);
  const guardianPromptFile = validateGuardianPromptFile(value.guardianPromptFile);
  return {
    reviewers,
    reviewContext,
    reactiveReview,
    boundaryReview,
    ...(value.policy ? { policy: value.policy } : {}),
    ...(guardianPromptFile ? { guardianPromptFile } : {}),
  };
}

function validateBoundaryReview(value: unknown): NonNullable<PermissionReviewerConfig["boundaryReview"]> {
  if (value === undefined) return { ...DEFAULT_BOUNDARY_REVIEW };
  if (!isRecord(value)) throw new Error("boundaryReview must be an object");
  const gitFsmonitor = value.gitFsmonitor ?? DEFAULT_BOUNDARY_REVIEW.gitFsmonitor;
  const gitSshAgent = value.gitSshAgent ?? DEFAULT_BOUNDARY_REVIEW.gitSshAgent;
  if (typeof gitFsmonitor !== "boolean") {
    throw new Error("boundaryReview.gitFsmonitor must be a boolean");
  }
  if (gitSshAgent !== "review" && gitSshAgent !== "block") {
    throw new Error("boundaryReview.gitSshAgent must be review or block");
  }
  return { gitFsmonitor, gitSshAgent };
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
  writePrivateFileAtomically(path, `${JSON.stringify(validated, null, 2)}\n`);
  return loadConfig(path);
}

export function defaultConfigPath(): string {
  return (
    process.env.PI_PERMISSION_REVIEWER_CONFIG ??
    join(homedir(), ".pi", "agent", "permission-reviewer.json")
  );
}

export function defaultGuardianPromptPath(): string {
  return join(homedir(), ".pi", "agent", "permission-reviewer.guardian.md");
}

export function resolveGuardianPromptPath(
  promptFile: string,
  configPath = defaultConfigPath(),
): string {
  const validated = validateGuardianPromptFile(promptFile);
  if (!validated) throw new Error("guardianPromptFile must be a non-empty .md filename");
  if (validated.startsWith("~/")) return join(homedir(), validated.slice(2));
  return isAbsolute(validated) ? validated : resolve(dirname(configPath), validated);
}

export function saveGuardianPrompt(
  prompt: string,
  path = defaultGuardianPromptPath(),
): void {
  if (typeof prompt !== "string") throw new Error("guardian prompt must be text");
  if (Buffer.byteLength(prompt, "utf8") > MAX_GUARDIAN_PROMPT_BYTES) {
    throw new Error("guardian prompt must not exceed 32768 UTF-8 bytes");
  }
  writePrivateFileAtomically(path, prompt);
}

function loadGuardianPrompt(path: string): string {
  const guardedOpenFlags =
    process.platform === "win32"
      ? 0
      : constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | guardedOpenFlags);
  } catch (error) {
    if (isRecord(error) && error.code === "ELOOP") {
      throw new Error("guardian prompt must be a regular file, not a symbolic link");
    }
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("guardian prompt must be a regular file");
    if (stat.size > MAX_GUARDIAN_PROMPT_BYTES) {
      throw new Error("guardian prompt must not exceed 32768 UTF-8 bytes");
    }
    const buffer = Buffer.allocUnsafe(MAX_GUARDIAN_PROMPT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const count = readSync(
        descriptor,
        buffer,
        bytesRead,
        buffer.byteLength - bytesRead,
        null,
      );
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > MAX_GUARDIAN_PROMPT_BYTES) {
      throw new Error("guardian prompt must not exceed 32768 UTF-8 bytes");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, bytesRead),
    );
  } finally {
    closeSync(descriptor);
  }
}

function validateGuardianPromptFile(value: unknown): string | undefined {
  if (value === undefined) return;
  if (typeof value !== "string") throw new Error("guardianPromptFile must be a string");
  if (value.includes("\0")) throw new Error("guardianPromptFile must not contain NUL");
  const filename = basename(value);
  if (
    value.trim().length === 0 ||
    !filename.endsWith(".md") ||
    filename.slice(0, -".md".length).trim().length === 0
  ) {
    throw new Error("guardianPromptFile must be a non-empty .md filename");
  }
  return value;
}

function writePrivateFileAtomically(path: string, contents: string): void {
  const directory = dirname(path);
  const temporary = join(
    directory,
    `.permission-reviewer.${process.pid}.${Date.now()}.tmp`,
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporary, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
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
