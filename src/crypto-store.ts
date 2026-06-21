import type { SourceConfig } from "./types";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptText(secret: string, value: string): Promise<string> {
  const key = await deriveKey(secret);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(cipher))}`;
}

export async function decryptText(secret: string, value: string): Promise<string> {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("Unsupported encrypted value");
  const key = await deriveKey(secret);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(parts[1]!) },
    key,
    base64ToBytes(parts[2]!)
  );
  return new TextDecoder().decode(plain);
}

export async function sealSources(sources: SourceConfig[], secret?: string): Promise<SourceConfig[]> {
  if (!secret) throw new Error("CONFIG_ENCRYPTION_KEY secret is required");
  return Promise.all(
    sources.map(async (source) => {
      const encrypted = source.url ? await encryptText(secret, source.url) : source.urlEncrypted;
      return { ...source, url: "", urlEncrypted: encrypted };
    })
  );
}

export async function unsealSources(sources: SourceConfig[], secret?: string): Promise<SourceConfig[]> {
  if (!secret && sources.some((source) => source.url || source.urlEncrypted)) {
    throw new Error("CONFIG_ENCRYPTION_KEY secret is required");
  }
  return Promise.all(
    sources.map(async (source) => {
      if (!source.urlEncrypted || !secret) return { ...source };
      return { ...source, url: await decryptText(secret, source.urlEncrypted) };
    })
  );
}
