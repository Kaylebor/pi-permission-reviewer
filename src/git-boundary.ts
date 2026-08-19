import { constants, closeSync, fstatSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import type { BoundaryRequest } from "./review-types.ts";
import { validatePublicKeyFile } from "./public-key-boundary.ts";
import { publicKeyConflictsWithDeny } from "./explicit-boundary.ts";

const execFileAsync = promisify(execFile);

const CONTAINED_BUILTINS = new Set([
  "add", "annotate", "blame", "branch", "cat-file", "check-attr",
  "check-ignore", "check-ref-format", "checkout", "clean", "commit",
  "describe", "diff", "diff-files", "diff-index", "diff-tree", "fetch",
  "for-each-ref", "grep", "hash-object", "help", "index-pack", "log",
  "ls-files", "ls-tree", "merge", "merge-base", "merge-tree", "mv",
  "name-rev", "notes", "pull", "push", "read-tree", "rebase", "reflog",
  "remote", "reset", "restore", "rev-list", "rev-parse", "rm", "show",
  "show-ref", "sparse-checkout", "status", "switch", "symbolic-ref", "tag",
  "update-index", "update-ref", "verify-commit", "verify-pack", "verify-tag",
  "worktree", "write-tree",
]);

const SSH_REMOTE_BUILTINS = new Set(["fetch", "pull", "push"]);
const FORBIDDEN_GLOBAL = new Set([
  "-C", "-c", "--config-env", "--exec-path", "--git-dir", "--namespace",
  "--super-prefix", "--work-tree",
]);

export interface GitBoundaryPlan {
  command: string;
  argv: readonly string[];
  builtin: string;
  repositoryRoot?: string;
  fsmonitorSocket?: string;
  sshAgentRequest?: Readonly<BoundaryRequest>;
  sshDestinationRequest?: Readonly<BoundaryRequest>;
  sshAuthSock?: string;
  knownHostsHome?: string;
  knownHostsRequests?: readonly Readonly<BoundaryRequest>[];
  knownHostsError?: string;
  publicKeyRequest?: Readonly<BoundaryRequest>;
  publicKeyError?: string;
}

export async function detectGitBoundary(
  command: string,
  cwd: string,
  options: {
    gitBinary?: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
  } = {},
): Promise<GitBoundaryPlan | undefined> {
  if (!isAbsolute(cwd)) return;
  const argv = tokenizeDirectCommand(command);
  if (!argv || argv[0] !== "git" || argv.length < 2) return;
  const builtinIndex = findBuiltinIndex(argv);
  if (builtinIndex !== 1) return;
  const builtin = argv[builtinIndex]!;
  if (!CONTAINED_BUILTINS.has(builtin)) return;
  const gitBinary = options.gitBinary ?? "git";
  const repositoryRoot = await gitOutput(gitBinary, cwd, [
    "rev-parse", "--show-toplevel",
  ]);
  const plan: GitBoundaryPlan = { command, argv, builtin };
  if (repositoryRoot && isWithin(cwd, repositoryRoot)) {
    plan.repositoryRoot = repositoryRoot;
    const socket = await gitOutput(gitBinary, cwd, [
      "rev-parse", "--path-format=absolute", "--git-path",
      "fsmonitor--daemon.ipc",
    ]);
    if (socket && isAbsolute(socket)) {
      plan.fsmonitorSocket = socket;
    }
  }
  const environment = options.environment ?? process.env;
  const sshAuthSock = environment.SSH_AUTH_SOCK;
  const sshDestination = SSH_REMOTE_BUILTINS.has(builtin) &&
    !await gitOutput(gitBinary, cwd, ["config", "--get", "core.sshCommand"])
    ? await gitRemoteSshDestination(gitBinary, cwd, builtin, argv.slice(2))
    : undefined;
  const signedByArgument = requestsSignature(argv.slice(2));
  const signedByConfig = builtin === "commit"
    ? await gitBoolean(gitBinary, cwd, "commit.gpgSign")
    : builtin === "tag"
      ? await gitBoolean(gitBinary, cwd, "tag.gpgSign") ||
        await gitBoolean(gitBinary, cwd, "tag.forceSignAnnotated")
      : false;
  const signedWithSsh = (builtin === "commit" || builtin === "tag") &&
    (signedByArgument || signedByConfig) &&
    (await gitOutput(gitBinary, cwd, ["config", "--get", "gpg.format"])) === "ssh" &&
    !await gitOutput(gitBinary, cwd, ["config", "--get", "gpg.ssh.program"]);
  if (signedWithSsh) {
    const configuredKey = await gitOutput(gitBinary, cwd, ["config", "--get", "user.signingKey"]);
    if (configuredKey && !isInlinePublicKey(configuredKey)) {
      const publicKeyPath = await gitOutput(gitBinary, cwd, [
        "config", "--path", "--get", "user.signingKey",
      ]);
      if (!publicKeyPath?.endsWith(".pub") || !isAbsolute(publicKeyPath)) {
        plan.publicKeyError = "SSH signing requires user.signingKey to name a public .pub file or a key:: public key; private-key paths remain sandbox-denied";
      } else {
        try {
          validatePublicKeyFile(publicKeyPath);
          plan.publicKeyRequest = Object.freeze({
            kind: "public-key-read",
            resource: publicKeyPath,
            phase: "preflight",
            reason: `Git ${builtin} requested its configured validated SSH public key`,
            platform: process.platform,
          });
        } catch (error) {
          plan.publicKeyError = `Configured SSH signing public key is unsafe or invalid: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }
  }
  if (sshDestination) {
    plan.sshDestinationRequest = Object.freeze({
      kind: "network-destination",
      resource: `${sshDestination.host}:${sshDestination.port}`,
      phase: "preflight",
      reason: `Git ${builtin} requested SSH access to its resolved remote`,
      platform: process.platform,
    });
    const knownHostsHome = options.homeDirectory ?? homedir();
    try {
      const requests = defaultKnownHostsFiles(knownHostsHome)
        .filter((path) => validateKnownHostsFile(path, knownHostsHome))
        .map((resource) => Object.freeze({
          kind: "filesystem-read" as const,
          resource,
          phase: "preflight" as const,
          reason: `Git ${builtin} requested its validated SSH host-key database`,
          platform: process.platform,
        }));
      if (requests.length > 0) {
        plan.knownHostsHome = knownHostsHome;
        plan.knownHostsRequests = Object.freeze(requests);
      }
    } catch (error) {
      plan.knownHostsError = `Configured SSH host-key database is unsafe or invalid: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (sshAuthSock && isAbsolute(sshAuthSock) &&
      (sshDestination !== undefined || signedWithSsh)) {
    plan.sshAuthSock = sshAuthSock;
    plan.sshAgentRequest = Object.freeze({
      kind: "ssh-agent",
      resource: sshAuthSock,
      phase: "preflight",
      reason: `Git ${builtin} requested access to the SSH agent`,
      platform: process.platform,
    });
  }
  return plan;
}

async function gitRemoteSshDestination(
  binary: string,
  cwd: string,
  builtin: string,
  args: readonly string[],
): Promise<{ host: string; port: number } | undefined> {
  const candidate = firstRemoteArgument(args);
  if (candidate && looksLikeRemoteUrl(candidate)) return parseSshDestination(candidate);
  let remote = candidate;
  if (!remote && (builtin === "pull" || builtin === "push")) {
    const upstream = await gitOutput(binary, cwd, [
      "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}",
    ]);
    remote = upstream?.split("/", 1)[0];
  }
  remote ??= "origin";
  const url = await gitOutput(binary, cwd, ["remote", "get-url", remote]);
  return url ? parseSshDestination(url) : undefined;
}

function firstRemoteArgument(args: readonly string[]): string | undefined {
  const consumesNext = new Set([
    "--depth", "--deepen", "--filter", "--jobs", "--negotiation-tip",
    "--refmap", "--server-option", "--shallow-exclude", "--shallow-since",
    "--upload-pack", "-j", "-o",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") return args[index + 1];
    if (consumesNext.has(arg)) { index += 1; continue; }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return;
}

function looksLikeRemoteUrl(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:\/\/|[^/@\s]+@[^/:\s]+:|\/)/i.test(value);
}

function isSshRemote(value: string): boolean {
  return /^ssh:\/\//i.test(value) || /^[^/@\s]+@[^/:\s]+:.+/.test(value);
}

function parseSshDestination(value: string): { host: string; port: number } | undefined {
  if (/^ssh:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return url.hostname ? { host: url.hostname.toLowerCase(), port: Number(url.port) || 22 } : undefined;
    } catch { return undefined; }
  }
  const match = value.match(/^[^/@\s]+@([^/:\s]+):.+$/);
  return match ? { host: match[1]!.toLowerCase(), port: 22 } : undefined;
}

export function applyGitBoundaryPlan(
  settings: Readonly<Record<string, unknown>>,
  plan: GitBoundaryPlan,
  options: {
    platform?: NodeJS.Platform;
    enableFsmonitor?: boolean;
    grantSshAgent?: boolean;
    cwd?: string;
  } = {},
): { settings: Record<string, unknown>; environment: Record<string, string> } {
  const platform = options.platform ?? process.platform;
  const next = structuredClone(settings) as Record<string, unknown>;
  const environment: Record<string, string> = {};
  const network = record(next.network);
  next.network = network;
  if (options.enableFsmonitor !== false && plan.fsmonitorSocket) {
    if (platform === "darwin") addUnique(network, "allowUnixSockets", plan.fsmonitorSocket);
    else if (platform === "linux") addGitConfig(environment, "core.fsmonitor", "false");
  }
  if (options.grantSshAgent && plan.sshAuthSock) {
    environment.SSH_AUTH_SOCK = plan.sshAuthSock;
    if (platform === "darwin") addUnique(network, "allowUnixSockets", plan.sshAuthSock);
    else if (platform === "linux") network.allowAllUnixSockets = true;
  }
  if (plan.sshDestinationRequest) {
    addUnique(network, "allowedDomains", plan.sshDestinationRequest.resource);
  }
  if (plan.publicKeyRequest) {
    validatePublicKeyFile(plan.publicKeyRequest.resource);
    if (publicKeyConflictsWithDeny(settings, plan.publicKeyRequest.resource, options.cwd)) {
      throw new Error("validated public-key read conflicts with a specific sandbox deny");
    }
    const filesystem = record(next.filesystem);
    next.filesystem = filesystem;
    addUnique(filesystem, "allowRead", plan.publicKeyRequest.resource);
  }
  for (const request of plan.knownHostsRequests ?? []) {
    if (!validateKnownHostsFile(request.resource, plan.knownHostsHome ?? homedir())) {
      throw new Error("validated SSH host-key database disappeared before execution");
    }
    if (publicKeyConflictsWithDeny(settings, request.resource, options.cwd)) {
      throw new Error("validated SSH host-key database conflicts with a specific sandbox deny");
    }
    const filesystem = record(next.filesystem);
    next.filesystem = filesystem;
    addUnique(filesystem, "allowRead", request.resource);
  }
  return { settings: next, environment };
}

function defaultKnownHostsFiles(home: string): string[] {
  if (!isAbsolute(home) || normalize(home) !== home) {
    throw new Error("home directory must be a normalized absolute path");
  }
  return [join(home, ".ssh", "known_hosts"), join(home, ".ssh", "known_hosts2")];
}

/** Validate metadata only; host-key database contents never leave OpenSSH. */
function validateKnownHostsFile(path: string, home: string): boolean {
  if (!defaultKnownHostsFiles(home).includes(path)) {
    throw new Error("host-key reads require an exact default known_hosts path");
  }
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const nonBlock = process.platform === "win32" ? 0 : constants.O_NONBLOCK;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | noFollow | nonBlock);
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("host-key database must be a regular file");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("host-key database must be owned by the current user");
    }
    if ((stat.mode & 0o022) !== 0) {
      throw new Error("host-key database must not be group- or world-writable");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    if (error instanceof Error && /host-key/.test(error.message)) throw error;
    throw new Error(`could not safely validate host-key database: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isInlinePublicKey(value: string): boolean {
  return value.startsWith("key::") || /^(?:ssh-|ecdsa-|sk-)/.test(value);
}

export function gitBoundaryConflictsWithDeny(
  settings: Readonly<Record<string, unknown>>,
  plan: GitBoundaryPlan,
  options: {
    platform?: NodeJS.Platform;
    enableFsmonitor?: boolean;
    grantSshAgent?: boolean;
    cwd?: string;
  } = {},
): boolean {
  if (
    plan.publicKeyRequest &&
    publicKeyConflictsWithDeny(settings, plan.publicKeyRequest.resource, options.cwd)
  ) return true;
  if ((plan.knownHostsRequests ?? []).some((request) =>
    publicKeyConflictsWithDeny(settings, request.resource, options.cwd)
  )) return true;
  const network = record(settings.network);
  const denied = Array.isArray(network.denyUnixSockets)
    ? network.denyUnixSockets.filter((item): item is string => typeof item === "string")
    : [];
  const platform = options.platform ?? process.platform;
  if (platform === "linux" && options.grantSshAgent && denied.length > 0) {
    return true;
  }
  const resources = [
    ...(options.enableFsmonitor === false ? [] : [plan.fsmonitorSocket]),
    ...(options.grantSshAgent ? [plan.sshAuthSock] : []),
  ].filter((item): item is string => typeof item === "string");
  if (plan.sshDestinationRequest) {
    const deniedDomains = Array.isArray(network.deniedDomains)
      ? network.deniedDomains.filter((item): item is string => typeof item === "string")
      : [];
    if (deniedDomains.some((pattern) => networkDestinationPatternMatches(
      pattern,
      plan.sshDestinationRequest!.resource,
    ))) return true;
  }
  return resources.some((resource) => denied.some((pattern) =>
    unixSocketPatternMatches(resource, pattern, options.cwd ?? process.cwd()),
  ));
}

function networkDestinationPatternMatches(pattern: string, destination: string): boolean {
  const [host, port] = destination.toLowerCase().split(":");
  const [deniedHost, deniedPort] = pattern.toLowerCase().split(":");
  const hostMatches = deniedHost === "*" || deniedHost === host ||
    (deniedHost.startsWith("*.") && host.endsWith(deniedHost.slice(1)));
  return hostMatches && (!deniedPort || deniedPort === port);
}

function tokenizeDirectCommand(command: string): string[] | undefined {
  const result: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const char of command.trim()) {
    if (escaped) { token += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = undefined; else token += char; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char)) { if (token) { result.push(token); token = ""; } continue; }
    if (/[|&;<>`$(){}\n\r]/.test(char)) return;
    token += char;
  }
  if (escaped || quote) return;
  if (token) result.push(token);
  return result;
}

function findBuiltinIndex(argv: readonly string[]): number | undefined {
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const key = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (FORBIDDEN_GLOBAL.has(key)) return;
    if (arg.startsWith("-")) return;
    return index;
  }
  return;
}

function requestsSignature(args: readonly string[]): boolean {
  return args.some((arg) => arg === "-S" || arg.startsWith("-S") || arg === "--gpg-sign" || arg.startsWith("--gpg-sign="));
}

async function gitOutput(binary: string, cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(binary, args, {
      cwd,
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 64 * 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C" },
    });
    return stdout.trim() || undefined;
  } catch { return; }
}

async function gitBoolean(binary: string, cwd: string, key: string): Promise<boolean> {
  return (await gitOutput(binary, cwd, ["config", "--type=bool", "--get", key])) === "true";
}

function isWithin(cwd: string, root: string): boolean {
  const child = relative(resolve(root), resolve(cwd));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function addUnique(target: Record<string, unknown>, key: string, value: string): void {
  const current = Array.isArray(target[key]) ? target[key] as unknown[] : [];
  target[key] = [...new Set([...current.filter((item): item is string => typeof item === "string"), value])];
}

function addGitConfig(environment: Record<string, string>, key: string, value: string): void {
  const index = Number(environment.GIT_CONFIG_COUNT ?? 0);
  environment.GIT_CONFIG_COUNT = String(index + 1);
  environment[`GIT_CONFIG_KEY_${index}`] = key;
  environment[`GIT_CONFIG_VALUE_${index}`] = value;
}

function unixSocketPatternMatches(resource: string, pattern: string, cwd: string): boolean {
  if (!pattern) return false;
  if (/[\[\]{}()!+@]/.test(pattern)) return true;
  const normalized = resource.replaceAll("\\", "/");
  const expanded = pattern === "~" ? process.env.HOME
    : pattern.startsWith("~/") && process.env.HOME
      ? `${process.env.HOME}/${pattern.slice(2)}`
      : pattern;
  if (!expanded) return true;
  const source = (isAbsolute(expanded) ? expanded : resolve(cwd, expanded)).replaceAll("\\", "/");
  if (!/[?*]/.test(source)) {
    return normalized === source || normalized.startsWith(`${source.replace(/\/$/, "")}/`);
  }
  let regex = "^";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === "*" && source[index + 1] === "*") { index += 1; regex += ".*"; }
    else if (char === "*") regex += "[^/]*";
    else if (char === "?") regex += "[^/]";
    else regex += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${regex}(?:/.*)?$`).test(normalized);
}
