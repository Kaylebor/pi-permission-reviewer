import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createPiPermAdapter,
  type PiPermAdapterDependencies,
} from "../src/pi-perm-adapter.ts";

const cwd = process.cwd();

function fakeDependencies(
  overrides: Partial<{
    manifest: unknown;
    extension: unknown;
    config: unknown;
    srt: unknown;
  }> = {},
): PiPermAdapterDependencies {
  const state = {
    cwd,
    config: {},
    activeProfile: "workspace",
    sessionAllows: new Map(),
    sessionFilesystemAllows: new Map(),
  };
  const modules = {
    extension:
      overrides.extension ?? {
        createPiPermExtension() {
          return {
            state,
            async handleToolCall() {
              return undefined;
            },
          };
        },
      },
    config:
      overrides.config ?? {
        getActiveProfile(receivedState: typeof state) {
          return { cwd: receivedState.cwd };
        },
      },
    srt:
      overrides.srt ?? {
        toSrtSettings(profile: { cwd: string }) {
          return {
            profileCwd: profile.cwd,
            filesystem: { denyRead: ["/private"] },
          };
        },
      },
  };
  return {
    resolvePackageRoot: () => "/fake/pi-perm",
    readPackageManifest: async () =>
      overrides.manifest ?? { name: "pi-perm", version: "0.1.8" },
    importModule: async (specifier) => {
      if (specifier.endsWith("extension.ts")) return modules.extension;
      if (specifier.endsWith("config.ts")) return modules.config;
      if (specifier.endsWith("srt.ts")) return modules.srt;
      throw new Error(`unexpected import: ${specifier}`);
    },
  };
}

test("uses the current CWD for private pi-perm decisions and SRT snapshots", async () => {
  const observedCwds: string[] = [];
  const nextCwd = join(cwd, "subdirectory");
  const dependencies = fakeDependencies({
    extension: {
      createPiPermExtension() {
        const state = {
          cwd,
          config: {},
          activeProfile: "workspace",
          sessionAllows: new Map([["old", {}]]),
          sessionFilesystemAllows: new Map([["old", {}]]),
        };
        return {
          state,
          async handleToolCall() {
            observedCwds.push(state.cwd);
            return undefined;
          },
        };
      },
    },
    config: {
      getActiveProfile(state: { cwd: string }) {
        observedCwds.push(state.cwd);
        return { cwd: state.cwd };
      },
    },
  });
  const adapter = await createPiPermAdapter({ cwd }, dependencies);
  const ctx = { cwd: nextCwd } as any;

  assert.equal(
    await adapter.handleToolCall(
      { toolName: "bash", toolCallId: "cwd-check", input: { command: "pwd" } } as any,
      ctx,
    ),
    undefined,
  );
  const settings = await adapter.getHardenedSrtSettings(nextCwd);

  assert.deepEqual(observedCwds, [cwd, nextCwd, nextCwd]);
  assert.equal(settings.profileCwd, nextCwd);
  assert.ok(
    (settings.filesystem as { denyRead: string[] }).denyRead.includes("~/.ssh"),
  );
  assert.equal(Object.isFrozen(settings), true);
  assert.equal(Object.isFrozen(settings.filesystem), true);
  assert.throws(() => {
    (settings.filesystem as { denyRead: string[] }).denyRead.push("/mutated");
  }, TypeError);
  await adapter.resetSession();
});

test("clears private session grants at Pi session boundaries", async () => {
  const state = {
    cwd,
    config: {},
    activeProfile: "workspace",
    sessionAllows: new Map([["grant", { lastUsedAt: Date.now() }]]),
    sessionFilesystemAllows: new Map([["path", { lastUsedAt: Date.now() }]]),
  };
  const adapter = await createPiPermAdapter(
    { cwd },
    fakeDependencies({
      extension: {
        createPiPermExtension() {
          return { state, async handleToolCall() {} };
        },
      },
    }),
  );
  await adapter.resetSession();
  assert.equal(state.sessionAllows.size, 0);
  assert.equal(state.sessionFilesystemAllows.size, 0);
});

test("fails closed for a package version mismatch", async () => {
  const adapter = await createPiPermAdapter(
    { cwd },
    fakeDependencies({ manifest: { name: "pi-perm", version: "0.1.9" } }),
  );

  const decision = await adapter.handleToolCall({} as any, { cwd } as any);
  assert.equal(decision?.block, true);
  assert.match(String(decision?.reason), /requires pi-perm 0\.1\.8/);
  await assert.rejects(adapter.getHardenedSrtSettings(cwd), /failed to initialize/);
});

test("fails closed for malformed private module exports and extension shapes", async () => {
  const missingExport = await createPiPermAdapter(
    { cwd },
    fakeDependencies({ extension: {} }),
  );
  const missingDecision = await missingExport.handleToolCall(
    {} as any,
    { cwd } as any,
  );
  assert.match(
    String(missingDecision?.reason),
    /createPiPermExtension has an unsupported shape/,
  );

  const malformedExtension = await createPiPermAdapter(
    { cwd },
    fakeDependencies({
      extension: {
        createPiPermExtension() {
          return {
            state: {
              cwd,
              config: {},
              activeProfile: "workspace",
              sessionAllows: new Map(),
              sessionFilesystemAllows: new Map(),
            },
          };
        },
      },
    }),
  );
  const malformedDecision = await malformedExtension.handleToolCall(
    {} as any,
    { cwd } as any,
  );
  assert.match(
    String(malformedDecision?.reason),
    /handleToolCall has an unsupported shape/,
  );

  const malformedSettings = await createPiPermAdapter(
    { cwd },
    fakeDependencies({
      srt: { toSrtSettings() { return []; } },
    }),
  );
  const settingsDecision = await malformedSettings.handleToolCall(
    {} as any,
    { cwd } as any,
  );
  assert.match(
    String(settingsDecision?.reason),
    /toSrtSettings result has an unsupported shape/,
  );
});

test("fails closed when a private decision violates the validated contract", async () => {
  const adapter = await createPiPermAdapter(
    { cwd },
    fakeDependencies({
      extension: {
        createPiPermExtension() {
          return {
            state: {
              cwd,
              config: {},
              activeProfile: "workspace",
              sessionAllows: new Map(),
              sessionFilesystemAllows: new Map(),
            },
            async handleToolCall() {
              return { block: "no" };
            },
          };
        },
      },
    }),
  );

  const decision = await adapter.handleToolCall({} as any, { cwd } as any);
  assert.deepEqual(decision?.block, true);
  assert.match(String(decision?.reason), /failed to evaluate/);
});

test("validates the installed pi-perm 0.1.8 contract", async () => {
  const runtimeBaseDir = mkdtempSync(join(tmpdir(), "pi-perm-adapter-runtime-"));
  const previousConfig = process.env.PI_PERM_USER_CONFIG;
  const configPath = join(runtimeBaseDir, "pi-perm.toml");
  process.env.PI_PERM_USER_CONFIG = configPath;
  try {
    const adapter = await createPiPermAdapter({ cwd, runtimeBaseDir });
    assert.equal(adapter.initializationError, undefined);
    const settings = await adapter.getHardenedSrtSettings(cwd);
    assert.equal(Object.isFrozen(settings), true);
    assert.ok("filesystem" in settings);
  } finally {
    if (previousConfig === undefined) delete process.env.PI_PERM_USER_CONFIG;
    else process.env.PI_PERM_USER_CONFIG = previousConfig;
  }
});
