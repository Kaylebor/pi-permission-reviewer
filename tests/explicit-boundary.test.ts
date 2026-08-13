import assert from "node:assert/strict";
import test from "node:test";
import {
  boundaryConflictsWithDeny,
  materializeExplicitBoundaries,
  planExplicitBoundaries,
} from "../src/explicit-boundary.ts";

test("plans exact explicit access with review levels matching consequence", () => {
  const read = planExplicitBoundaries({ read: ["/repo/README.md"] }, { platform: "darwin" });
  assert.equal(read?.minimumLevel, 0);
  assert.deepEqual(read?.boundaries.map(({ kind, resource, phase }) => ({ kind, resource, phase })), [
    { kind: "filesystem-read", resource: "/repo/README.md", phase: "preflight" },
  ]);

  const consequential = planExplicitBoundaries({
    write: ["/repo/result.txt"],
    unixSockets: ["/tmp/service.sock"],
    sshAgent: true,
  }, {
    platform: "linux",
    environment: { SSH_AUTH_SOCK: "/tmp/agent.sock" },
  });
  assert.equal(consequential?.minimumLevel, 1);
  assert.deepEqual(consequential?.boundaries.map(({ kind }) => kind), [
    "filesystem-write",
    "unix-socket",
    "ssh-agent",
  ]);
  assert.match(consequential?.policyReason ?? "", /disables AF_UNIX isolation/);
});

test("rejects ambiguous, excessive, unknown, empty, and unavailable requests", () => {
  for (const permissions of [
    {},
    { read: ["relative"] },
    { read: ["/tmp/*"] },
    { read: Array.from({ length: 17 }, (_, index) => `/tmp/${index}`) },
    { read: ["/" + "a".repeat(4_090)] },
    { execute: ["/bin/tool"] },
    { sshAgent: "true" },
  ]) {
    assert.throws(() => planExplicitBoundaries(permissions), /permissions|unsupported|SSH/);
  }
  assert.throws(
    () => planExplicitBoundaries({ sshAgent: true }, { environment: {} }),
    /SSH_AUTH_SOCK/,
  );
});

test("materializes only reviewed capabilities and preserves deterministic denies", () => {
  const plan = planExplicitBoundaries({
    read: ["/repo/input.txt"],
    write: ["/repo/output.txt"],
    unixSockets: ["/tmp/service.sock"],
    sshAgent: true,
  }, {
    platform: "darwin",
    environment: { SSH_AUTH_SOCK: "/tmp/agent.sock" },
  })!;
  assert.deepEqual(materializeExplicitBoundaries({}, plan, { platform: "darwin", cwd: "/repo" }), {
    settings: {
      filesystem: {
        allowRead: ["/repo/input.txt"],
        allowWrite: ["/repo/output.txt"],
      },
      network: { allowUnixSockets: ["/tmp/service.sock", "/tmp/agent.sock"] },
    },
    environment: { SSH_AUTH_SOCK: "/tmp/agent.sock" },
  });

  assert.equal(boundaryConflictsWithDeny(
    { filesystem: { denyRead: ["secrets/**"] } },
    planExplicitBoundaries({ read: ["/repo/secrets/key"] })!.boundaries[0]!,
    "/repo",
  ), true);
  assert.throws(
    () => materializeExplicitBoundaries(
      { filesystem: { denyRead: ["/repo/secrets/**"] } },
      planExplicitBoundaries({ read: ["/repo/secrets/key"] })!,
      { cwd: "/repo" },
    ),
    /explicit sandbox deny/,
  );
  assert.throws(
    () => materializeExplicitBoundaries(
      { filesystem: { denyRead: ["/repo/secrets/private.key"] } },
      planExplicitBoundaries({ read: ["/repo"] })!,
      { cwd: "/repo" },
    ),
    /explicit sandbox deny/,
  );
  assert.throws(
    () => materializeExplicitBoundaries(
      { filesystem: { denyWrite: ["secrets\/**"] } },
      planExplicitBoundaries({ write: ["/repo"] })!,
      { cwd: "/repo" },
    ),
    /explicit sandbox deny/,
  );
  assert.throws(
    () => materializeExplicitBoundaries(
      { filesystem: { denyRead: ["/srv/*/secret"] } },
      planExplicitBoundaries({ read: ["/srv/app"] })!,
    ),
    /explicit sandbox deny/,
  );
});

test("Linux socket grants remain one-invocation broad and fail closed over socket denies", () => {
  const plan = planExplicitBoundaries(
    { unixSockets: ["/tmp/service.sock"] },
    { platform: "linux" },
  )!;
  assert.deepEqual(materializeExplicitBoundaries({}, plan, { platform: "linux" }), {
    settings: { filesystem: {}, network: { allowAllUnixSockets: true } },
    environment: {},
  });
  assert.throws(
    () => materializeExplicitBoundaries(
      { network: { denyUnixSockets: ["/tmp/docker.sock"] } },
      plan,
      { platform: "linux" },
    ),
    /explicit sandbox deny/,
  );
});
