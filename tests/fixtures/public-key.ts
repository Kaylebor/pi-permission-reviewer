export function testSshPublicKey(comment = "test"): string {
  const type = Buffer.from("ssh-ed25519", "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(type.length);
  const blob = Buffer.concat([length, type, Buffer.alloc(32, 7)]);
  return `ssh-ed25519 ${blob.toString("base64")} ${comment}\n`;
}
