import { Buffer } from "node:buffer";
import nacl from "tweetnacl";
import { blake2b } from "blakejs";

/** GitHub Actions uses libsodium sealed boxes: ephemeral key || crypto_box. */
export function sealGitHubSecret(publicKey: string, value: string): string {
  const recipient = Buffer.from(publicKey, "base64");
  if (recipient.length !== nacl.box.publicKeyLength) throw new Error("Invalid GitHub repository public key");
  const ephemeral = nacl.box.keyPair.fromSecretKey(crypto.getRandomValues(new Uint8Array(nacl.box.secretKeyLength)));
  const plain = new TextEncoder().encode(value);
  try {
    const nonce = blake2b(Buffer.concat([ephemeral.publicKey, recipient]), undefined, nacl.box.nonceLength);
    const cipher = nacl.box(plain, nonce, recipient, ephemeral.secretKey);
    return Buffer.concat([ephemeral.publicKey, cipher]).toString("base64");
  } finally {
    ephemeral.secretKey.fill(0);
    plain.fill(0);
  }
}
