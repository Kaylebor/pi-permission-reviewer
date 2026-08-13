import assert from "node:assert/strict";
import test from "node:test";
import {
  applyGitBoundaryPlan,
  detectGitBoundary,
  gitBoundaryConflictsWithDeny,
} from "../src/git-boundary.ts";

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
