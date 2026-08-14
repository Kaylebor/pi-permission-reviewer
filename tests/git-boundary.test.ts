import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyGitBoundaryPlan,
  detectGitBoundary,
  gitBoundaryConflictsWithDeny,
} from "../src/git-boundary.ts";
import { testSshPublicKey } from "./fixtures/public-key.ts";

test("recognizes direct Git built-ins and rejects boundary-changing syntax", async () => {
  assert.equal((await detectGitBoundary("git status", process.cwd()))?.builtin, "status");
  for (const command of [
    "env git status",
    "git -C /tmp status",
    "git -c core.fsmonitor=false status",
    "git --git-dir=/tmp/x status",
    "git status | cat",
    "git made-up-command",
  ]) assert.equal(await detectGitBoundary(command, process.cwd()), undefined);
});

test("explicit Unix-socket denies remain authoritative over Git overlays", () => {
  const plan = {
    command: "git fetch",
    argv: ["git", "fetch"],
    builtin: "fetch",
    fsmonitorSocket: "/tmp/repo/.git/fsmonitor--daemon.ipc",
    sshAuthSock: "/tmp/ssh-agent.sock",
  };
  assert.equal(gitBoundaryConflictsWithDeny(
    { network: { denyUnixSockets: ["/tmp/repo/.git/**"] } },
    plan,
    { platform: "darwin" },
  ), true);
  assert.equal(gitBoundaryConflictsWithDeny(
    { network: { denyUnixSockets: [".git/fsmonitor--daemon.ipc"] } },
    {
      ...plan,
      fsmonitorSocket: "/tmp/repo/.git/fsmonitor--daemon.ipc",
    },
    { platform: "darwin", cwd: "/tmp/repo" },
  ), true);
  assert.equal(gitBoundaryConflictsWithDeny(
    { network: { denyUnixSockets: ["/tmp/docker.sock"] } },
    plan,
    { platform: "linux", grantSshAgent: true },
  ), true);
});

test("specific public-key denies remain authoritative over Git signing", () => {
  const publicKey = "/Users/test/.ssh/signing.pub";
  assert.equal(gitBoundaryConflictsWithDeny(
    { filesystem: { denyRead: [publicKey] } },
    {
      command: "git commit -S -m test",
      argv: ["git", "commit", "-S", "-m", "test"],
      builtin: "commit",
      publicKeyRequest: {
        kind: "public-key-read",
        resource: publicKey,
        phase: "preflight",
        reason: "test",
      },
    },
  ), true);
});

test("materializes platform-scoped Git capabilities without changing global config", () => {
  const plan = {
    command: "git status",
    argv: ["git", "status"],
    builtin: "status",
    fsmonitorSocket: "/tmp/repo/.git/fsmonitor--daemon.ipc",
    sshAuthSock: "/tmp/ssh-agent.sock",
  };
  assert.deepEqual(applyGitBoundaryPlan({}, plan, { platform: "darwin", grantSshAgent: true }), {
    settings: { network: { allowUnixSockets: [
      "/tmp/repo/.git/fsmonitor--daemon.ipc",
      "/tmp/ssh-agent.sock",
    ] } },
    environment: { SSH_AUTH_SOCK: "/tmp/ssh-agent.sock" },
  });
  assert.deepEqual(applyGitBoundaryPlan({}, plan, { platform: "linux", grantSshAgent: true }), {
    settings: { network: { allowAllUnixSockets: true } },
    environment: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "false",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
    },
  });
});

test("signed Git operations reuse the generic validated public-key capability", async () => {
  const repository = mkdtempSync(join(tmpdir(), "git-public-key-"));
  const key = join(repository, "signing.pub");
  writeFileSync(key, testSshPublicKey(), { mode: 0o644 });
  execFileSync("git", ["init", "-q", repository]);
  for (const [name, value] of [
    ["commit.gpgSign", "true"],
    ["gpg.format", "ssh"],
    ["user.signingKey", key],
  ]) execFileSync("git", ["-C", repository, "config", name, value]);
  const plan = await detectGitBoundary("git commit -m test", repository, {
    environment: { SSH_AUTH_SOCK: "/tmp/agent.sock" },
  });
  assert.equal(plan?.publicKeyRequest?.kind, "public-key-read");
  assert.equal(plan?.publicKeyRequest?.resource, key);
  const applied = applyGitBoundaryPlan({}, plan!, { platform: "darwin", grantSshAgent: true });
  assert.deepEqual(
    (applied.settings.filesystem as { allowRead: string[] }).allowRead,
    [key],
  );
  unlinkSync(key);
  assert.throws(
    () => applyGitBoundaryPlan({}, plan!, { platform: "darwin", grantSshAgent: true }),
    /safely validate public key/,
  );
});

test("signed Git operations reject configured private-key paths", async () => {
  const repository = mkdtempSync(join(tmpdir(), "git-private-key-"));
  const key = join(repository, "signing-key");
  writeFileSync(key, "private material is never inspected\n", { mode: 0o600 });
  execFileSync("git", ["init", "-q", repository]);
  for (const [name, value] of [
    ["commit.gpgSign", "true"],
    ["gpg.format", "ssh"],
    ["user.signingKey", key],
  ]) execFileSync("git", ["-C", repository, "config", name, value]);
  const plan = await detectGitBoundary("git commit -m test", repository, {
    environment: { SSH_AUTH_SOCK: "/tmp/agent.sock" },
  });
  assert.match(plan?.publicKeyError ?? "", /public \.pub file/);
  assert.equal(plan?.publicKeyRequest, undefined);
});
