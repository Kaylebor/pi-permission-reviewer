import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import type { NetworkDecision } from "./review-types.ts";

export interface NetworkRequest {
  host: string;
  port?: number;
}

interface WorkerMessage {
  type: "started" | "output" | "network-request" | "result" | "error";
  toolCallId?: string;
  requestId?: string;
  host?: string;
  port?: number;
  data?: string;
  exitCode?: number | null;
  error?: string;
  childPid?: number;
  invocationNonce?: string;
}

export async function runReactiveSandbox(options: {
  toolCallId: string;
  command: string;
  cwd: string;
  /** Cloned before spawning so execution cannot observe caller mutation. */
  settings: Readonly<Record<string, unknown>>;
  /** Sanitized, immutable overlay for the worker and sandboxed child. */
  environment?: Readonly<NodeJS.ProcessEnv>;
  onData(data: Buffer): void;
  /**
   * The caller owns eligibility, policy, reviewer, and human decisions. This
   * transport only converts the resulting decision to the worker's Boolean
   * IPC protocol at the final boundary.
   */
  onNetworkRequest(
    request: NetworkRequest,
    signal: AbortSignal,
  ): Promise<NetworkDecision>;
  /** Receives each first decision for observability without affecting IPC. */
  onNetworkDecision?(decision: NetworkDecision, destination: NetworkRequest): void;
  /** Stable ReviewCase id when available; toolCallId remains a safe fallback. */
  caseId?: string;
  signal?: AbortSignal;
  /** Pi's public bash timeout, in seconds. */
  timeout?: number;
  workerPath?: string;
  nodeBinary?: string;
  networkRequestLimit?: number;
  networkReviewTimeoutMs?: number;
}): Promise<{ exitCode: number | null }> {
  if (options.signal?.aborted) throw new Error("aborted");
  const settings = immutableSettings(options.settings);
  const environment = immutableWorkerEnvironment(options.environment);
  const timeoutMs = requestedTimeoutMs(options.timeout);
  const worker = spawn(
    options.nodeBinary ?? process.env.PI_PERMISSION_REVIEWER_NODE ?? "node",
    [options.workerPath ?? fileURLToPath(new URL("./sandbox-worker.mjs", import.meta.url))],
    {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: environment,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    },
  );
  const decisions = new Map<string, Promise<NetworkDecision>>();
  let decisionQueue = Promise.resolve();
  const invocationNonce = randomUUID();
  const reviewLifecycle = new AbortController();
  const caseId = options.caseId ?? options.toolCallId;

  return new Promise((resolve, reject) => {
    let settled = false;
    let sandboxChildPid: number | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const settle = (error?: Error, result?: { exitCode: number | null }) => {
      if (settled) return;
      settled = true;
      reviewLifecycle.abort(new Error("sandbox invocation settled"));
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result ?? { exitCode: null });
    };
    const terminateWorker = () => {
      signalProcessGroup(sandboxChildPid, "SIGKILL");
      signalProcessGroup(worker.pid, "SIGKILL");
    };
    const sendWorker = (message: Record<string, unknown>) => {
      if (!worker.connected) return;
      worker.send(message, (error) => {
        if (error && !settled && !options.signal?.aborted) {
          terminateWorker();
          settle(error);
        }
      });
    };
    const onAbort = () => {
      reviewLifecycle.abort(options.signal?.reason ?? new Error("aborted"));
      sendWorker({ type: "abort", invocationNonce });
      forceKillTimer = setTimeout(terminateWorker, 1_000);
      forceKillTimer.unref();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    worker.stderr?.on("data", (data) => options.onData(Buffer.from(data)));
    worker.on("error", (error) => {
      terminateWorker();
      settle(error);
    });
    worker.on("exit", (code, signal) => {
      if (!settled) {
        terminateWorker();
        settle(
          new Error(
            options.signal?.aborted
              ? "aborted"
              : `sandbox worker exited before completion (${signal ?? code ?? "unknown"})`,
          ),
        );
      }
    });
    worker.on("message", (raw) => {
      const message = raw as WorkerMessage;
      if (message.invocationNonce !== invocationNonce) {
        settle(new Error("sandbox worker IPC authentication failed"));
        terminateWorker();
        return;
      }
      if (message.type === "started") {
        if (
          message.toolCallId === options.toolCallId &&
          Number.isSafeInteger(message.childPid) &&
          Number(message.childPid) > 1
        ) {
          sandboxChildPid = message.childPid;
        }
        return;
      }
      if (message.type === "output" && typeof message.data === "string") {
        options.onData(Buffer.from(message.data, "base64"));
        return;
      }
      if (message.type === "network-request") {
        const invalidDestination = diagnosticDestination(message);
        if (
          message.toolCallId !== options.toolCallId ||
          typeof message.requestId !== "string" ||
          typeof message.host !== "string" ||
          !validHost(message.host) ||
          (message.port !== undefined && !validPort(message.port))
        ) {
          if (typeof message.requestId === "string") {
            respondToNetworkRequest(
              message.requestId,
              denyNetworkDecision(caseId, "error", "invalid network request"),
              invalidDestination,
            );
          }
          return;
        }
        const canonical = canonicalizeNetworkDestination({
          host: message.host,
          ...(message.port !== undefined ? { port: message.port } : {}),
        });
        if (!canonical) {
          respondToNetworkRequest(
            message.requestId,
            denyNetworkDecision(caseId, "error", "invalid network destination"),
            invalidDestination,
          );
          return;
        }
        const key = `${canonical.host}:${canonical.port ?? "*"}`;
        let decision = decisions.get(key);
        if (!decision) {
          if (decisions.size >= (options.networkRequestLimit ?? 8)) {
            respondToNetworkRequest(
              message.requestId,
              denyNetworkDecision(
                caseId,
                "limit",
                "network destination review limit reached",
              ),
              canonical,
            );
            return;
          } else {
            const reviewController = new AbortController();
            const reviewSignal = AbortSignal.any([
              reviewLifecycle.signal,
              reviewController.signal,
            ]);
            decision = decisionQueue.then(async () => {
              if (reviewLifecycle.signal.aborted || settled) {
                return denyNetworkDecision(caseId, "cancelled", "network review cancelled");
              }
              const timeout = setTimeout(
                () => reviewController.abort(new Error("network review timed out")),
                options.networkReviewTimeoutMs ?? 30_000,
              );
              timeout.unref();
              try {
                const review = Promise.resolve()
                  .then(() => options.onNetworkRequest(canonical, reviewSignal))
                  .then(
                    (response) => ({ kind: "response" as const, response }),
                    () => ({ kind: "failure" as const }),
                  );
                const lifecycleCancelled = new Promise<{ kind: "cancelled" }>((resolve) => {
                  reviewLifecycle.signal.addEventListener(
                    "abort",
                    () => resolve({ kind: "cancelled" }),
                    { once: true },
                  );
                });
                const reviewTimedOut = new Promise<{ kind: "timeout" }>((resolve) => {
                  reviewController.signal.addEventListener(
                    "abort",
                    () => resolve({ kind: "timeout" }),
                    { once: true },
                  );
                });
                const outcome = await Promise.race([review, lifecycleCancelled, reviewTimedOut]);
                if (outcome.kind === "timeout") {
                  return denyNetworkDecision(caseId, "timeout", "network review timed out");
                }
                if (outcome.kind === "cancelled") {
                  return denyNetworkDecision(caseId, "cancelled", "network review cancelled");
                }
                if (outcome.kind === "failure") {
                  return denyNetworkDecision(caseId, "error", "network reviewer failed");
                }
                const response = outcome.response;
                if (reviewController.signal.aborted) {
                  return denyNetworkDecision(caseId, "timeout", "network review timed out");
                }
                if (reviewLifecycle.signal.aborted || settled) {
                  return denyNetworkDecision(caseId, "cancelled", "network review cancelled");
                }
                if (!isNetworkDecision(response)) {
                  return denyNetworkDecision(
                    caseId,
                    "error",
                    "network reviewer returned an invalid decision",
                  );
                }
                if (response.caseId !== caseId) {
                  return denyNetworkDecision(
                    caseId,
                    "error",
                    "network decision does not match the active review case",
                  );
                }
                return response;
              } catch {
                if (reviewController.signal.aborted) {
                  return denyNetworkDecision(caseId, "timeout", "network review timed out");
                }
                if (reviewLifecycle.signal.aborted || settled) {
                  return denyNetworkDecision(caseId, "cancelled", "network review cancelled");
                }
                return denyNetworkDecision(caseId, "error", "network reviewer failed");
              } finally {
                clearTimeout(timeout);
              }
            });
            decision = decision.then((resolved) => {
              // Lifecycle cancellation is cleanup, not a policy denial. Avoid
              // reversing the causal chain in the user-facing diagnostic.
              if (!settled && !reviewLifecycle.signal.aborted) {
                notifyNetworkDecision(options, resolved, canonical);
              }
              return resolved;
            });
            decisionQueue = decision.then(
              () => undefined,
              () => undefined,
            );
          }
          decisions.set(key, decision);
        }
        void decision
          .then((resolved) => {
            if (!settled && !reviewLifecycle.signal.aborted) {
              sendWorker({
                type: "network-response",
                invocationNonce,
                requestId: message.requestId,
                allow: resolved.decision === "allow",
              });
            }
          })
          .catch(() => {
            if (!settled && !reviewLifecycle.signal.aborted) {
              sendWorker({
                type: "network-response",
                invocationNonce,
                requestId: message.requestId,
                allow: false,
              });
            }
          });
        return;
      }
      if (message.type === "result") {
        settle(undefined, { exitCode: message.exitCode ?? null });
        return;
      }
      if (message.type === "error") {
        terminateWorker();
        settle(new Error(message.error ?? "sandbox worker failed"));
      }
    });
    const respondToNetworkRequest = (
      requestId: string,
      decision: NetworkDecision,
      destination: NetworkRequest,
    ) => {
      notifyNetworkDecision(options, decision, destination);
      sendWorker({
        type: "network-response",
        invocationNonce,
        requestId,
        allow: decision.decision === "allow",
      });
    };
    sendWorker({
      type: "start",
      invocationNonce,
      toolCallId: options.toolCallId,
      command: options.command,
      cwd: options.cwd,
      settings,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  });
}

function requestedTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return;
  const value = timeout * 1_000;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("timeout must be positive and finite");
  }
  return Math.min(value, 2_147_483_647);
}

function immutableSettings(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  try {
    return deepFreeze(structuredClone(value));
  } catch {
    throw new Error("sandbox settings must be structured-cloneable");
  }
}

export function immutableWorkerEnvironment(
  overlay: Readonly<NodeJS.ProcessEnv> | undefined,
): NodeJS.ProcessEnv {
  const explicit = sanitizedEnvironment(overlay ?? {});
  if (typeof overlay?.SSH_AUTH_SOCK === "string" && overlay.SSH_AUTH_SOCK) {
    explicit.SSH_AUTH_SOCK = overlay.SSH_AUTH_SOCK;
  }
  for (const [key, value] of Object.entries(overlay ?? {})) {
    if (
      typeof value === "string" &&
      (key === "GIT_CONFIG_COUNT" || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key))
    ) explicit[key] = value;
  }
  return Object.freeze({
    ...sanitizedEnvironment(process.env),
    ...explicit,
  });
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function denyNetworkDecision(
  caseId: string,
  source: Exclude<NetworkDecision["source"], "eligibility" | "policy" | "reviewer" | "human">,
  reason: string,
): NetworkDecision {
  return { decision: "deny", source, reason, caseId };
}

function isNetworkDecision(value: unknown): value is NetworkDecision {
  if (!isRecord(value)) return false;
  return (
    (value.decision === "allow" || value.decision === "deny") &&
    (value.source === "eligibility" ||
      value.source === "policy" ||
      value.source === "reviewer" ||
      value.source === "human" ||
      value.source === "timeout" ||
      value.source === "cancelled" ||
      value.source === "error" ||
      value.source === "limit") &&
    typeof value.reason === "string" &&
    typeof value.caseId === "string"
  );
}

function notifyNetworkDecision(
  options: { onNetworkDecision?: (decision: NetworkDecision, destination: NetworkRequest) => void },
  decision: NetworkDecision,
  destination: NetworkRequest,
): void {
  try {
    options.onNetworkDecision?.(decision, destination);
  } catch {
    // Diagnostics must never prevent a completed deny decision from reaching SRT.
  }
}

function diagnosticDestination(message: WorkerMessage): NetworkRequest {
  return {
    host: typeof message.host === "string" && validHost(message.host)
      ? message.host
      : "<invalid>",
    ...(message.port !== undefined && validPort(message.port) ? { port: message.port } : {}),
  };
}

export function hardenSandboxSettings(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const filesystem = isRecord(value.filesystem) ? value.filesystem : {};
  const denyRead = Array.isArray(filesystem.denyRead)
    ? filesystem.denyRead.filter((item): item is string => typeof item === "string")
    : [];
  return {
    ...value,
    filesystem: {
      ...filesystem,
      denyRead: [
        ...new Set([
          ...denyRead,
          "~/.ssh",
          "~/.aws",
          "~/.azure",
          "~/.config/gcloud",
          "~/.docker",
          "~/.kube",
          "~/.netrc",
          "~/.npmrc",
          "~/.git-credentials",
          "~/.pi/agent/auth.json",
          "~/.codex/auth.json",
          "~/Library/Keychains",
        ]),
      ],
    },
  };
}

export function sanitizedEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const allowed = new Set([
    "HOME",
    "LANG",
    "LOGNAME",
    "PATH",
    "PI_MODEL",
    "PI_PROVIDER",
    "PI_REASONING_LEVEL",
    "SHELL",
    "TERM",
    "TMPDIR",
    "TMP",
    "TEMP",
    "USER",
  ]);
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) =>
        value !== undefined &&
        (allowed.has(key) || key.startsWith("LC_")),
    ),
  );
}

export function canonicalizeNetworkDestination(
  destination: NetworkRequest,
): NetworkRequest | undefined {
  if (destination.port !== undefined && !validPort(destination.port)) return;
  const raw = destination.host;
  if (!validHost(raw)) return;
  const bracketed = raw.startsWith("[") && raw.endsWith("]");
  const authority = raw.includes(":") && !bracketed ? `[${raw}]` : raw;
  try {
    const url = new URL(`https://${authority}/`);
    if (
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return;
    let host = url.hostname.toLowerCase();
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    host = host.replace(/\.$/, "");
    if (!host || host.length > 253) return;
    return { host, ...(destination.port !== undefined ? { port: destination.port } : {}) };
  } catch {
    return;
  }
}

export function isPublicNetworkDestination(destination: NetworkRequest): boolean {
  const canonical = canonicalizeNetworkDestination(destination);
  if (!canonical) return false;
  const host = canonical.host;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "metadata.google.internal"
  )
    return false;
  if (isIP(host) === 4) return isGlobalIpv4(host);
  if (isIP(host) === 6) return isGlobalIpv6(host);
  return (
    host.includes(".") &&
    host.split(".").every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    )
  );
}

function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {}
}

function validHost(host: string): boolean {
  return host.length > 0 && host.length <= 253 && !/[\s\0-\x1f\x7f]/.test(host);
}

function isGlobalIpv4(host: string): boolean {
  const [a, b, c] = host.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isGlobalIpv6(host: string): boolean {
  const bytes = ipv6Bytes(host);
  if (!bytes) return false;
  const mapped = bytes.slice(0, 10).every((value) => value === 0) &&
    bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) {
    return isGlobalIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }
  // Restrict literal approval to the IPv6 global-unicast block and exclude
  // the documentation prefix. DNS names remain eligible and resolve inside SRT.
  return (
    (bytes[0] & 0xe0) === 0x20 &&
    !(bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8)
  );
}

function ipv6Bytes(host: string): number[] | undefined {
  const halves = host.split("::");
  if (halves.length > 2) return;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const parse = (part: string) => {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return;
    return Number.parseInt(part, 16);
  };
  const leftValues = left.map(parse);
  const rightValues = right.map(parse);
  if (leftValues.some((value) => value === undefined) || rightValues.some((value) => value === undefined)) return;
  const missing = 8 - leftValues.length - rightValues.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return;
  const words = [
    ...(leftValues as number[]),
    ...Array.from({ length: missing }, () => 0),
    ...(rightValues as number[]),
  ];
  return words.flatMap((word) => [word >> 8, word & 0xff]);
}

function validPort(port: number): boolean {
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
