import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import type { BoundaryRequest } from "./review-types.ts";
import { validatePublicKeyFile } from "./public-key-boundary.ts";

export interface BashPermissionRequest {
  read?: readonly string[];
  publicKeyRead?: readonly string[];
  write?: readonly string[];
  unixSockets?: readonly string[];
  sshAgent?: boolean;
  sshDestination?: { host: string; port?: number };
}

export interface ExplicitBoundaryPlan {
  permissions: Readonly<BashPermissionRequest>;
  boundaries: readonly Readonly<BoundaryRequest>[];
  minimumLevel: number;
  policyReason: string;
}

const MAX_PATHS_PER_KIND = 16;
const MAX_PATH_LENGTH = 4_096;
const MAX_PERMISSION_REQUEST_LENGTH = 4_096;

export function planExplicitBoundaries(
  value: unknown,
  options: { platform?: NodeJS.Platform; environment?: NodeJS.ProcessEnv } = {},
): ExplicitBoundaryPlan | undefined {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error("permissions must be an object");
  for (const key of Object.keys(value)) {
    if (!new Set(["read", "publicKeyRead", "write", "unixSockets", "sshAgent", "sshDestination"]).has(key)) {
      throw new Error(`unsupported permission field: ${key}`);
    }
  }
  const read = exactPaths(value.read, "permissions.read");
  const publicKeyRead = exactPaths(value.publicKeyRead, "permissions.publicKeyRead");
  const write = exactPaths(value.write, "permissions.write");
  const unixSockets = exactPaths(value.unixSockets, "permissions.unixSockets");
  if (value.sshAgent !== undefined && typeof value.sshAgent !== "boolean") {
    throw new Error("permissions.sshAgent must be a boolean");
  }
  const sshAgent = value.sshAgent === true;
  const sshDestination = exactSshDestination(value.sshDestination);
  if (read.length + publicKeyRead.length + write.length + unixSockets.length === 0 && !sshAgent && !sshDestination) {
    throw new Error("permissions must request at least one capability");
  }
  if (JSON.stringify({ read, publicKeyRead, write, unixSockets, sshAgent, sshDestination }).length > MAX_PERMISSION_REQUEST_LENGTH) {
    throw new Error(`permissions request must be at most ${MAX_PERMISSION_REQUEST_LENGTH} characters`);
  }
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const boundaries: BoundaryRequest[] = [
    ...read.map((resource) => boundary("filesystem-read", resource, "Read access was explicitly requested", platform)),
    ...publicKeyRead.map((resource) => boundary("public-key-read", resource, "Validated SSH public-key read access was requested", platform)),
    ...write.map((resource) => boundary("filesystem-write", resource, "Write access was explicitly requested", platform)),
    ...unixSockets.map((resource) => boundary(
      "unix-socket",
      resource,
      platform === "linux"
        ? "A Unix socket was requested; Linux SRT disables AF_UNIX isolation for this invocation, exposing Docker, Podman, and other local service sockets and potentially permitting control beyond the sandbox"
        : "Unix-socket access was explicitly requested",
      platform,
    )),
  ];
  if (sshAgent) {
    const socket = environment.SSH_AUTH_SOCK;
    if (!socket || !isExactAbsolutePath(socket)) {
      throw new Error("SSH agent requested but SSH_AUTH_SOCK is unavailable or invalid");
    }
    boundaries.push(boundary(
      "ssh-agent",
      socket,
      platform === "linux"
        ? "SSH-agent access was requested; Linux SRT disables AF_UNIX isolation for this invocation, exposing Docker, Podman, and other local service sockets and potentially permitting control beyond the sandbox"
        : "SSH-agent access was explicitly requested",
      platform,
    ));
  }
  if (sshDestination) {
    boundaries.push(boundary(
      "network-destination",
      formatSshDestination(sshDestination),
      "Exact SSH destination access was explicitly requested",
      platform,
    ));
  }
  return Object.freeze({
    permissions: Object.freeze({
      ...(read.length ? { read: Object.freeze(read) } : {}),
      ...(publicKeyRead.length ? { publicKeyRead: Object.freeze(publicKeyRead) } : {}),
      ...(write.length ? { write: Object.freeze(write) } : {}),
      ...(unixSockets.length ? { unixSockets: Object.freeze(unixSockets) } : {}),
      ...(sshAgent ? { sshAgent: true } : {}),
      ...(sshDestination ? { sshDestination: Object.freeze(sshDestination) } : {}),
    }),
    boundaries: Object.freeze(boundaries.map((item) => Object.freeze({ ...item }))),
    minimumLevel: write.length || unixSockets.length || sshAgent || sshDestination ? 1 : 0,
    policyReason: boundaries.map(({ reason, resource }) => `${reason}: ${resource}`).join("; "),
  });
}

export function materializeExplicitBoundaries(
  settings: Readonly<Record<string, unknown>>,
  plan: ExplicitBoundaryPlan,
  options: { platform?: NodeJS.Platform; cwd?: string } = {},
): { settings: Record<string, unknown>; environment: Record<string, string> } {
  const platform = options.platform ?? process.platform;
  const next = structuredClone(settings) as Record<string, unknown>;
  const filesystem = record(next.filesystem);
  const network = record(next.network);
  const environment: Record<string, string> = {};
  for (const boundary of plan.boundaries) {
    if (boundary.kind === "public-key-read") {
      validatePublicKeyFile(boundary.resource);
      if (publicKeyConflictsWithDeny(settings, boundary.resource, options.cwd)) {
        throw new Error(`requested ${boundary.kind} conflicts with an explicit sandbox deny: ${boundary.resource}`);
      }
    } else if (boundaryConflictsWithDeny(settings, boundary, options.cwd)) {
      throw new Error(`requested ${boundary.kind} conflicts with an explicit sandbox deny: ${boundary.resource}`);
    }
    if (boundary.kind === "filesystem-read" || boundary.kind === "public-key-read") {
      filesystem.allowRead = append(filesystem.allowRead, boundary.resource);
    } else if (boundary.kind === "filesystem-write") {
      filesystem.allowWrite = append(filesystem.allowWrite, boundary.resource);
    } else if (boundary.kind === "unix-socket") {
      if (platform === "linux") network.allowAllUnixSockets = true;
      else network.allowUnixSockets = append(network.allowUnixSockets, boundary.resource);
    } else if (boundary.kind === "ssh-agent") {
      environment.SSH_AUTH_SOCK = boundary.resource;
      if (platform === "linux") network.allowAllUnixSockets = true;
      else network.allowUnixSockets = append(network.allowUnixSockets, boundary.resource);
    } else if (boundary.kind === "network-destination") {
      if (networkDestinationConflictsWithDeny(network, boundary.resource)) {
        throw new Error(`requested ${boundary.kind} conflicts with an explicit sandbox deny: ${boundary.resource}`);
      }
      network.allowedDomains = append(network.allowedDomains, boundary.resource);
    }
  }
  next.filesystem = filesystem;
  next.network = network;
  return { settings: next, environment };
}

export function boundaryConflictsWithDeny(
  settings: Readonly<Record<string, unknown>>,
  boundary: Readonly<BoundaryRequest>,
  cwd = process.cwd(),
): boolean {
  const filesystem = record(settings.filesystem);
  const network = record(settings.network);
  if (boundary.kind === "filesystem-read") {
    return pathDeniedBy(boundary.resource, filesystem.denyRead, cwd);
  }
  if (boundary.kind === "public-key-read") {
    return publicKeyConflictsWithDeny(settings, boundary.resource, cwd);
  }
  if (boundary.kind === "filesystem-write") {
    return pathDeniedBy(boundary.resource, filesystem.denyWrite, cwd);
  }
  if (boundary.kind === "unix-socket" || boundary.kind === "ssh-agent") {
    const denied = Array.isArray(network.denyUnixSockets)
      ? network.denyUnixSockets.filter((item): item is string => typeof item === "string")
      : [];
    if (boundary.platform === "linux" && denied.length > 0) return true;
    return pathDeniedBy(boundary.resource, denied, cwd);
  }
  if (boundary.kind === "network-destination") {
    return networkDestinationConflictsWithDeny(network, boundary.resource);
  }
  return true;
}

/** Ignore only the package's built-in blanket ~/.ssh deny after validation. */
export function publicKeyConflictsWithDeny(
  settings: Readonly<Record<string, unknown>>,
  resource: string,
  cwd = process.cwd(),
): boolean {
  const filesystem = record(settings.filesystem);
  const home = homedir().replaceAll("\\", "/").replace(/\/$/, "");
  const configured = Array.isArray(filesystem.denyRead)
    ? filesystem.denyRead.filter((item): item is string =>
      typeof item === "string" && item !== "~/.ssh" && item !== `${home}/.ssh`)
    : [];
  return pathDeniedBy(resource, configured, cwd);
}

function exactPaths(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PATHS_PER_KIND) {
    throw new Error(`${label} must be an array of at most ${MAX_PATHS_PER_KIND} paths`);
  }
  const result = value.map((item) => {
    if (typeof item !== "string" || !isExactAbsolutePath(item)) {
      throw new Error(`${label} entries must be normalized absolute paths without globs`);
    }
    return item;
  });
  return [...new Set(result)];
}

function exactSshDestination(value: unknown): { host: string; port: number } | undefined {
  if (value === undefined) return;
  if (!isRecord(value) || typeof value.host !== "string" || !/^[A-Za-z0-9.-]+$/.test(value.host) || value.host.length > 253) {
    throw new Error("permissions.sshDestination must contain a valid host");
  }
  const port = value.port === undefined ? 22 : value.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("permissions.sshDestination.port must be an integer between 1 and 65535");
  }
  return { host: value.host.toLowerCase(), port };
}

function formatSshDestination(destination: { host: string; port: number }): string {
  return `${destination.host}:${destination.port}`;
}

function networkDestinationConflictsWithDeny(network: Readonly<Record<string, unknown>>, destination: string): boolean {
  const denied = Array.isArray(network.deniedDomains)
    ? network.deniedDomains.filter((item): item is string => typeof item === "string")
    : [];
  const [host, port] = destination.split(":");
  return denied.some((pattern) => {
    const [deniedHost, deniedPort] = pattern.toLowerCase().split(":");
    const hostMatches = deniedHost === "*" || deniedHost === host ||
      (deniedHost.startsWith("*.") && host.endsWith(deniedHost.slice(1)));
    return hostMatches && (!deniedPort || deniedPort === port);
  });
}

function isExactAbsolutePath(value: string): boolean {
  return value.length > 0 && value.length <= MAX_PATH_LENGTH &&
    isAbsolute(value) && normalize(value) === value &&
    !/[\0*?\[\]{}]/.test(value);
}

function boundary(
  kind: BoundaryRequest["kind"],
  resource: string,
  reason: string,
  platform: NodeJS.Platform,
): BoundaryRequest {
  return { kind, resource, phase: "preflight", reason, platform };
}

function pathDeniedBy(resource: string, configured: unknown, cwd: string): boolean {
  if (!Array.isArray(configured)) return false;
  const normalized = resource.replaceAll("\\", "/");
  const home = homedir().replaceAll("\\", "/").replace(/\/$/, "");
  for (const value of configured) {
    if (typeof value !== "string" || !value) continue;
    if (/[\[\]{}()!+@]/.test(value)) return true;
    const expanded = value === "~" ? home
      : value.startsWith("~/") ? `${home}/${value.slice(2)}`
      : value.replaceAll("\\", "/");
    const absolute = expanded.startsWith("/") ? expanded : join(cwd, expanded).replaceAll("\\", "/");
    if (!/[?*]/.test(absolute)) {
      const denied = absolute.replace(/\/$/, "");
      const requested = normalized.replace(/\/$/, "");
      if (
        requested === denied ||
        requested.startsWith(`${denied}/`) ||
        denied.startsWith(`${requested}/`)
      ) return true;
      continue;
    }
    if (globRegex(absolute).test(normalized)) return true;
    const firstGlob = absolute.search(/[?*]/);
    const literalPrefix = absolute.slice(0, firstGlob).replace(/\/$/, "");
    const requested = normalized.replace(/\/$/, "");
    if (
      literalPrefix &&
      (
        literalPrefix === requested ||
        literalPrefix.startsWith(`${requested}/`) ||
        requested.startsWith(`${literalPrefix}/`)
      )
    ) return true;
  }
  return false;
}

function globRegex(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") { index += 1; source += ".*"; }
    else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${source}(?:/.*)?$`);
}

function append(value: unknown, addition: string): string[] {
  const existing = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
  return [...new Set([...existing, addition])];
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
