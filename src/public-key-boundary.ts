import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

const MAX_PUBLIC_KEY_BYTES = 16 * 1024;
const PUBLIC_KEY_TYPE = /^(?:ssh-(?:ed25519|rsa|dss)(?:-cert-v01@openssh\.com)?|ecdsa-sha2-nistp(?:256|384|521)(?:-cert-v01@openssh\.com)?|sk-ssh-ed25519(?:-cert-v01)?@openssh\.com|sk-ecdsa-sha2-nistp256(?:-cert-v01)?@openssh\.com)$/;

/** Validate an exact SSH public-key file without following its final symlink. */
export function validatePublicKeyFile(path: string): void {
  if (!isAbsolute(path) || normalize(path) !== path || !path.endsWith(".pub")) {
    throw new Error("public-key reads require a normalized absolute .pub path");
  }
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const nonBlock = process.platform === "win32" ? 0 : constants.O_NONBLOCK;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | noFollow | nonBlock);
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("public key must be a regular file");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("public key must be owned by the current user");
    }
    if ((stat.mode & 0o022) !== 0) {
      throw new Error("public key must not be group- or world-writable");
    }
    if (stat.size < 1 || stat.size > MAX_PUBLIC_KEY_BYTES) {
      throw new Error(`public key must be between 1 and ${MAX_PUBLIC_KEY_BYTES} bytes`);
    }
    const buffer = Buffer.alloc(stat.size + 1);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes !== stat.size) throw new Error("public key changed while it was validated");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes));
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length !== 1) throw new Error("public key must contain exactly one key record");
    const fields = lines[0]!.trim().split(/\s+/);
    if (!PUBLIC_KEY_TYPE.test(fields[0] ?? "") || !isCanonicalPublicKeyBlob(fields[1] ?? "", fields[0] ?? "")) {
      throw new Error("file is not a supported SSH public key");
    }
  } catch (error) {
    if (error instanceof Error && /public key/.test(error.message)) throw error;
    throw new Error(`could not safely validate public key: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isCanonicalPublicKeyBlob(value: string, expectedType: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length < 8 || decoded.toString("base64") !== value) return false;
    const typeLength = decoded.readUInt32BE(0);
    return typeLength > 0 && typeLength <= decoded.length - 4 &&
      decoded.subarray(4, 4 + typeLength).toString("ascii") === expectedType;
  } catch {
    return false;
  }
}
