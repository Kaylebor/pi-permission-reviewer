import { createHash, randomUUID } from "node:crypto";
import type {
  ApprovalCapability,
  ReviewCase,
} from "./review-types.ts";
import type { ReviewRequest } from "./types.ts";

/** A capability is usable for one bash invocation for, at most, five minutes. */
export const CAPABILITY_TTL_MS = 5 * 60_000;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface CreateReviewCaseOptions {
  id?: string;
  sessionEpoch: number;
  configGeneration: number;
  toolCallId: string;
  tool: string;
  input: Record<string, unknown>;
  cwd: string;
  minimumLevel: number;
  policyReason?: string;
  directUserInput?: string;
  policy?: string;
  guardianPrompt?: string;
  sandboxSettings: Record<string, unknown>;
}

export interface ApprovalStoreOptions {
  /** Override only for deterministic tests. */
  now?: () => number;
  ttlMs?: number;
}

export interface ConsumeApprovalCapability {
  toolCallId: string;
  tool: string;
  input: Record<string, unknown>;
  cwd: string;
  configGeneration: number;
  sessionEpoch: number;
}

export type ApprovalCapabilityFailure =
  | "missing"
  | "replayed"
  | "expired"
  | "mismatch";

export type ConsumeApprovalResult =
  | { ok: true; capability: ApprovalCapability }
  | { ok: false; reason: ApprovalCapabilityFailure };

interface PendingCapability {
  capability: ApprovalCapability;
  expiresAt: number;
}

interface SpentCapability {
  state: "consumed" | "expired";
  expiresAt: number;
}

type CapabilityEntry = PendingCapability | SpentCapability;

/**
 * Build the immutable data boundary passed to reviewers and retained for later
 * execution.  The input digest is canonical, so property insertion order
 * cannot alter the authorization identity.
 */
export function createReviewCase(options: CreateReviewCaseOptions): ReviewCase {
  const input = cloneRecord(options.input, "review input");
  const sandboxSettings = cloneRecord(
    options.sandboxSettings,
    "sandbox settings",
  );
  const reviewCase: ReviewCase = {
    id: options.id ?? randomUUID(),
    sessionEpoch: options.sessionEpoch,
    configGeneration: options.configGeneration,
    toolCallId: options.toolCallId,
    tool: options.tool,
    input,
    inputDigest: canonicalSha256(input),
    cwd: options.cwd,
    minimumLevel: options.minimumLevel,
    ...(options.policyReason === undefined
      ? {}
      : { policyReason: options.policyReason }),
    ...(options.directUserInput === undefined
      ? {}
      : { directUserInput: options.directUserInput }),
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.guardianPrompt === undefined
      ? {}
      : { guardianPrompt: options.guardianPrompt }),
    sandboxSettings,
  };
  return freezeReviewCase(reviewCase);
}

/** Return the SHA-256 digest of a validated, property-order-independent value. */
export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/**
 * Stores single-use approval capabilities.  A case ID is first-wins for its
 * lifetime: concurrent duplicate review completions cannot replace an earlier
 * decision, and every consume attempt spends the pending capability.
 */
export class ApprovalStore {
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #entries = new Map<string, CapabilityEntry>();

  constructor(options: ApprovalStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? CAPABILITY_TTL_MS;
    if (!Number.isFinite(this.#ttlMs) || this.#ttlMs <= 0) {
      throw new Error("approval capability ttl must be a positive finite number");
    }
  }

  /** Returns false when this tool-call ID has already been remembered. */
  remember(capability: ApprovalCapability): boolean {
    const now = this.#now();
    this.#prune(now);
    const id = capability.reviewCase.toolCallId;
    if (this.#entries.has(id)) return false;
    const snapshot = snapshotCapability(capability);
    this.#entries.set(id, { capability: snapshot, expiresAt: now + this.#ttlMs });
    return true;
  }

  consume(invocation: ConsumeApprovalCapability): ConsumeApprovalResult {
    const now = this.#now();
    this.#prune(now);
    const entry = this.#entries.get(invocation.toolCallId);
    if (!entry) return { ok: false, reason: "missing" };
    if ("state" in entry) {
      return { ok: false, reason: entry.state === "expired" ? "expired" : "replayed" };
    }
    if (now >= entry.expiresAt) {
      this.#entries.set(invocation.toolCallId, {
        state: "expired",
        expiresAt: now + this.#ttlMs,
      });
      return { ok: false, reason: "expired" };
    }

    // A failed validation is still an attempted use.  Spend it before returning
    // so callers cannot use a failed attempt as an oracle or retry it later.
    this.#entries.set(invocation.toolCallId, {
      state: "consumed",
      expiresAt: now + this.#ttlMs,
    });
    if (!matches(entry.capability.reviewCase, invocation)) {
      return { ok: false, reason: "mismatch" };
    }
    return { ok: true, capability: entry.capability };
  }

  clear(toolCallId: string): void {
    this.#entries.delete(toolCallId);
  }

  clearAll(): void {
    this.#entries.clear();
  }

  #prune(now: number): void {
    for (const [id, entry] of this.#entries) {
      if ("state" in entry && now >= entry.expiresAt) this.#entries.delete(id);
    }
  }
}

function matches(reviewCase: ReviewCase, invocation: ConsumeApprovalCapability): boolean {
  if (
    reviewCase.toolCallId !== invocation.toolCallId ||
    reviewCase.tool !== invocation.tool ||
    reviewCase.cwd !== invocation.cwd ||
    reviewCase.configGeneration !== invocation.configGeneration ||
    reviewCase.sessionEpoch !== invocation.sessionEpoch
  ) {
    return false;
  }
  try {
    return reviewCase.inputDigest === canonicalSha256(invocation.input);
  } catch {
    return false;
  }
}

function snapshotCapability(capability: ApprovalCapability): ApprovalCapability {
  const reviewCase = capability.reviewCase;
  if (reviewCase.inputDigest !== canonicalSha256(reviewCase.input)) {
    throw new Error("approval capability review case has an invalid input digest");
  }
  const copiedCase = createReviewCase({
    id: reviewCase.id,
    sessionEpoch: reviewCase.sessionEpoch,
    configGeneration: reviewCase.configGeneration,
    toolCallId: reviewCase.toolCallId,
    tool: reviewCase.tool,
    input: reviewCase.input,
    cwd: reviewCase.cwd,
    minimumLevel: reviewCase.minimumLevel,
    ...(reviewCase.policyReason === undefined
      ? {}
      : { policyReason: reviewCase.policyReason }),
    ...(reviewCase.directUserInput === undefined
      ? {}
      : { directUserInput: reviewCase.directUserInput }),
    ...(reviewCase.policy === undefined ? {} : { policy: reviewCase.policy }),
    ...(reviewCase.guardianPrompt === undefined
      ? {}
      : { guardianPrompt: reviewCase.guardianPrompt }),
    sandboxSettings: reviewCase.sandboxSettings,
  });
  const request = freezeRequest({
    tool: copiedCase.tool,
    input: copiedCase.input as Record<string, unknown>,
    cwd: copiedCase.cwd,
    minimumLevel: copiedCase.minimumLevel,
    ...(copiedCase.policyReason === undefined
      ? {}
      : { policyReason: copiedCase.policyReason }),
    ...(copiedCase.directUserInput === undefined
      ? {}
      : { directUserInput: copiedCase.directUserInput }),
  });
  const result: ApprovalCapability = {
    reviewCase: copiedCase,
    request,
    ...(capability.reviewer === undefined
      ? {}
      : { reviewer: freezeJsonRecord(capability.reviewer, "reviewer") as unknown as ApprovalCapability["reviewer"] }),
    ...(capability.assessment === undefined
      ? {}
      : { assessment: freezeJsonRecord(capability.assessment, "assessment") as unknown as ApprovalCapability["assessment"] }),
  };
  return Object.freeze(result);
}

function freezeRequest(request: ReviewRequest): ReviewRequest {
  return Object.freeze(request);
}

function freezeReviewCase(reviewCase: ReviewCase): ReviewCase {
  freezeJsonValue(reviewCase.input);
  freezeJsonValue(reviewCase.sandboxSettings);
  return Object.freeze(reviewCase);
}

function cloneRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  const cloned = cloneJsonValue(value, label);
  if (Array.isArray(cloned) || cloned === null || typeof cloned !== "object") {
    throw new Error(`${label} must be a plain object`);
  }
  freezeJsonValue(cloned);
  return cloned;
}

function freezeJsonRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  return cloneRecord(value, label);
}

function cloneJsonValue(
  value: unknown,
  label: string,
  active = new WeakSet<object>(),
): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return value;
  }
  if (typeof value !== "object") throw new Error(`${label} contains non-JSON ${typeof value}`);
  if (active.has(value)) throw new Error(`${label} contains a cycle`);
  active.add(value);
  try {
    if (Array.isArray(value)) return cloneArray(value, label, active);
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error(`${label} contains a non-plain object`);
    }
    const result: { [key: string]: JsonValue } = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") throw new Error(`${label} contains a symbol key`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error(`${label} contains a non-JSON property`);
      }
      Object.defineProperty(result, key, {
        value: cloneJsonValue(descriptor.value, label, active),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  } finally {
    active.delete(value);
  }
}

function cloneArray(value: unknown[], label: string, active: WeakSet<object>): JsonValue[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} contains an array with a custom prototype`);
  }
  const result: JsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error(`${label} contains a sparse or non-JSON array`);
    }
    result.push(cloneJsonValue(descriptor.value, label, active));
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) {
    throw new Error(`${label} contains a non-JSON array property`);
  }
  return result;
}

function freezeJsonValue(value: JsonValue | Readonly<Record<string, unknown>>): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor && typeof descriptor.value === "object" && descriptor.value !== null) {
      freezeJsonValue(descriptor.value as JsonValue);
    }
  }
  Object.freeze(value);
}

function canonicalJson(value: unknown): string {
  const cloned = cloneJsonValue(value, "canonical value");
  return serializeCanonical(cloned);
}

function serializeCanonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializeCanonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serializeCanonical(value[key]!)}`)
    .join(",")}}`;
}
