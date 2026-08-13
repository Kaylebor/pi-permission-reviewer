import type {
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hardenSandboxSettings } from "./reactive-sandbox.ts";

const PI_PERM_VERSION = "0.1.8";

export interface PermissionDecision {
  block?: boolean;
  reason?: string;
  terminate?: boolean;
}

export interface PiPermAdapter {
  /** The CWD used to construct the private pi-perm state. */
  readonly initialCwd: string;
  /** Present when the private dependency could not be safely initialized. */
  readonly initializationError?: string;
  handleToolCall(
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): Promise<PermissionDecision | undefined>;
  getHardenedSrtSettings(
    cwd: string,
  ): Promise<Readonly<Record<string, unknown>>>;
  /** Clears private pi-perm grants at each Pi session boundary. */
  resetSession(): Promise<void>;
}

export interface PiPermAdapterOptions {
  cwd: string;
  events?: unknown;
  runtimeBaseDir?: string;
  commandExists?: (command: string) => boolean;
}

/** Test-only seams for the untyped private pi-perm API. */
export interface PiPermAdapterDependencies {
  resolvePackageRoot?: () => string;
  readPackageManifest?: (packageRoot: string) => Promise<unknown>;
  importModule?: (specifier: string) => Promise<unknown>;
}

interface PiPermState {
  cwd: string;
  config: Record<string, unknown>;
  activeProfile: string;
  sessionAllows: Map<unknown, unknown>;
  sessionFilesystemAllows: Map<unknown, unknown>;
}

interface PrivatePiPermExtension {
  state: PiPermState;
  handleToolCall(
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): Promise<unknown>;
}

interface PrivatePiPermModules {
  createPiPermExtension: (options: Record<string, unknown>) => unknown;
  getActiveProfile: (state: PiPermState) => unknown;
  toSrtSettings: (profile: Record<string, unknown>) => unknown;
}

export async function createPiPermAdapter(
  options: PiPermAdapterOptions,
  dependencies: PiPermAdapterDependencies = {},
): Promise<PiPermAdapter> {
  const initialCwd = validateCwd(options.cwd);
  if (!initialCwd) {
    return failedAdapter(String(options.cwd), "pi-perm adapter requires an absolute CWD");
  }

  try {
    const packageRoot =
      dependencies.resolvePackageRoot?.() ?? defaultResolvePackageRoot();
    const manifest = await (
      dependencies.readPackageManifest ?? defaultReadPackageManifest
    )(packageRoot);
    validatePackageManifest(manifest);

    const importModule = dependencies.importModule ?? defaultImportModule;
    const modules = await loadPrivateModules(importModule);
    const extension = validateExtension(
      modules.createPiPermExtension({
        cwd: initialCwd,
        events: options.events,
        // Bash execution is owned by this extension's bundled SRT worker.
        commandExists: options.commandExists ?? (() => true),
        extensionRoot: packageRoot,
        runtimeBaseDir:
          options.runtimeBaseDir ??
          process.env.PI_PERMISSION_REVIEWER_RUNTIME_DIR ??
          join(homedir(), ".pi", "agent", "permission-reviewer"),
      }),
    );
    validateProfileAndSettings(extension, modules);

    return new ActivePiPermAdapter(initialCwd, extension, modules);
  } catch (error) {
    return failedAdapter(initialCwd, initializationReason(error));
  }
}

class ActivePiPermAdapter implements PiPermAdapter {
  readonly initializationError = undefined;
  #tail: Promise<void> = Promise.resolve();
  readonly #extension: PrivatePiPermExtension;
  readonly #modules: PrivatePiPermModules;

  constructor(
    readonly initialCwd: string,
    extension: PrivatePiPermExtension,
    modules: PrivatePiPermModules,
  ) {
    this.#extension = extension;
    this.#modules = modules;
  }

  handleToolCall(
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): Promise<PermissionDecision | undefined> {
    return this.#withCwd(ctx.cwd, async () => {
      try {
        return validateDecision(await this.#extension.handleToolCall(event, ctx));
      } catch (error) {
        return blockedDecision(`Permission engine failed to evaluate: ${errorMessage(error)}`);
      }
    });
  }

  getHardenedSrtSettings(
    cwd: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    return this.#withCwd(cwd, () => {
      const profile = asRecord(
        this.#modules.getActiveProfile(this.#extension.state),
        "pi-perm getActiveProfile result",
      );
      const settings = asRecord(
        this.#modules.toSrtSettings(profile),
        "pi-perm toSrtSettings result",
      );
      return deepFreeze(hardenSandboxSettings(structuredClone(settings)));
    });
  }

  resetSession(): Promise<void> {
    return this.#withCwd(this.initialCwd, () => {
      this.#extension.state.sessionAllows.clear();
      this.#extension.state.sessionFilesystemAllows.clear();
    });
  }

  #withCwd<T>(cwd: string, operation: () => Promise<T> | T): Promise<T> {
    const validatedCwd = validateCwd(cwd);
    if (!validatedCwd) {
      return Promise.reject(new Error("pi-perm adapter requires an absolute CWD"));
    }
    const run = this.#tail.then(async () => {
      this.#extension.state.cwd = validatedCwd;
      return operation();
    });
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function failedAdapter(initialCwd: string, error: string): PiPermAdapter {
  const reason = `Permission engine failed to initialize: ${error}`;
  return {
    initialCwd,
    initializationError: reason,
    async handleToolCall() {
      return blockedDecision(reason);
    },
    async getHardenedSrtSettings() {
      throw new Error(reason);
    },
    async resetSession() {},
  };
}

async function loadPrivateModules(
  importModule: (specifier: string) => Promise<unknown>,
): Promise<PrivatePiPermModules> {
  const [extensionModule, configModule, srtModule] = await Promise.all([
    importModule("pi-perm/" + "core/extension.ts"),
    importModule("pi-perm/" + "core/config.ts"),
    importModule("pi-perm/" + "core/srt.ts"),
  ]);
  const extension = asRecord(extensionModule, "pi-perm extension module");
  const config = asRecord(configModule, "pi-perm config module");
  const srt = asRecord(srtModule, "pi-perm SRT module");
  return {
    createPiPermExtension: asFunction(
      extension.createPiPermExtension,
      "pi-perm createPiPermExtension",
    ),
    getActiveProfile: asFunction(
      config.getActiveProfile,
      "pi-perm getActiveProfile",
    ),
    toSrtSettings: asFunction(srt.toSrtSettings, "pi-perm toSrtSettings"),
  };
}

function validateExtension(value: unknown): PrivatePiPermExtension {
  const extension = asRecord(value, "pi-perm extension");
  const state = asRecord(extension.state, "pi-perm extension state");
  if (
    typeof state.cwd !== "string" ||
    !isAbsolute(state.cwd) ||
    !isRecord(state.config) ||
    typeof state.activeProfile !== "string" ||
    state.activeProfile.length === 0 ||
    !(state.sessionAllows instanceof Map) ||
    !(state.sessionFilesystemAllows instanceof Map)
  ) {
    throw new Error("pi-perm extension state has an unsupported shape");
  }
  return {
    state: state as unknown as PiPermState,
    handleToolCall: asFunction(
      extension.handleToolCall,
      "pi-perm extension handleToolCall",
    ),
  };
}

function validateProfileAndSettings(
  extension: PrivatePiPermExtension,
  modules: PrivatePiPermModules,
): void {
  const profile = asRecord(
    modules.getActiveProfile(extension.state),
    "pi-perm getActiveProfile result",
  );
  asRecord(modules.toSrtSettings(profile), "pi-perm toSrtSettings result");
}

function validatePackageManifest(value: unknown): void {
  const manifest = asRecord(value, "pi-perm package manifest");
  if (manifest.name !== "pi-perm" || manifest.version !== PI_PERM_VERSION) {
    throw new Error(
      `requires pi-perm ${PI_PERM_VERSION}; found ${String(manifest.version)}`,
    );
  }
}

function validateDecision(value: unknown): PermissionDecision | undefined {
  if (value === undefined) return undefined;
  const decision = asRecord(value, "pi-perm tool decision");
  if (
    (decision.block !== undefined && typeof decision.block !== "boolean") ||
    (decision.reason !== undefined && typeof decision.reason !== "string") ||
    (decision.terminate !== undefined && typeof decision.terminate !== "boolean")
  ) {
    throw new Error("pi-perm tool decision has an unsupported shape");
  }
  return {
    ...(decision.block !== undefined ? { block: decision.block } : {}),
    ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    ...(decision.terminate !== undefined ? { terminate: decision.terminate } : {}),
  };
}

function validateCwd(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && isAbsolute(value)
    ? value
    : undefined;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${name} has an unsupported shape`);
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asFunction<T extends (...args: never[]) => unknown>(
  value: unknown,
  name: string,
): T {
  if (typeof value !== "function") {
    throw new Error(`${name} has an unsupported shape`);
  }
  return value as T;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function blockedDecision(reason: string): PermissionDecision {
  return { block: true, reason, terminate: true };
}

function initializationReason(error: unknown): string {
  return errorMessage(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultResolvePackageRoot(): string {
  return dirname(fileURLToPath(import.meta.resolve("pi-perm/package.json")));
}

async function defaultReadPackageManifest(packageRoot: string): Promise<unknown> {
  return JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
}

async function defaultImportModule(specifier: string): Promise<unknown> {
  return import(specifier);
}
