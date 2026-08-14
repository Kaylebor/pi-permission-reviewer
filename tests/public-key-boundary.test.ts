import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validatePublicKeyFile } from "../src/public-key-boundary.ts";
import { testSshPublicKey } from "./fixtures/public-key.ts";

test("accepts one bounded owner-controlled SSH public key", () => {
  const dir = mkdtempSync(join(tmpdir(), "public-key-boundary-"));
  const path = join(dir, "signing.pub");
  writeFileSync(path, testSshPublicKey(), { mode: 0o644 });
  assert.doesNotThrow(() => validatePublicKeyFile(path));
});

test("rejects malformed, mislabeled, writable, and symlink public-key paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "public-key-boundary-"));
  const malformed = join(dir, "malformed.pub");
  writeFileSync(malformed, "not a public key\n", { mode: 0o644 });
  assert.throws(() => validatePublicKeyFile(malformed), /supported SSH public key/);
  const mislabeled = join(dir, "signing.key");
  writeFileSync(mislabeled, testSshPublicKey(), { mode: 0o644 });
  assert.throws(() => validatePublicKeyFile(mislabeled), /absolute \.pub path/);
  const writable = join(dir, "writable.pub");
  writeFileSync(writable, testSshPublicKey(), { mode: 0o644 });
  chmodSync(writable, 0o666);
  assert.throws(() => validatePublicKeyFile(writable), /must not be group- or world-writable/);
  if (process.platform !== "win32") {
    const linked = join(dir, "linked.pub");
    symlinkSync(malformed, linked);
    assert.throws(() => validatePublicKeyFile(linked), /safely validate public key/);
  }
});
