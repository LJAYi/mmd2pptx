import type { GitHubTokenSet } from "./contracts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid base64url value");
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function randomToken(byteLength = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

export function isPkceChallenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/u.test(value);
}

export function isPkceVerifier(value: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/u.test(value);
}

export function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function importEncryptionKey(encodedKey: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(encodedKey), (character) => character.charCodeAt(0));
  if (raw.byteLength !== 32) throw new Error("SESSION_ENCRYPTION_KEY must contain 32 bytes");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptTokenSet(
  value: GitHubTokenSet,
  encodedKey: string,
  sessionHandle: string,
): Promise<string> {
  const key = await importEncryptionKey(encodedKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(sessionHandle) },
    key,
    plaintext,
  );
  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

export async function decryptTokenSet(
  value: string,
  encodedKey: string,
  sessionHandle: string,
): Promise<GitHubTokenSet> {
  const [version, encodedIv, encodedCiphertext, extra] = value.split(".");
  if (version !== "v1" || !encodedIv || !encodedCiphertext || extra) {
    throw new Error("Unsupported encrypted session value");
  }
  const key = await importEncryptionKey(encodedKey);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlDecode(encodedIv),
      additionalData: encoder.encode(sessionHandle),
    },
    key,
    base64UrlDecode(encodedCiphertext),
  );
  return JSON.parse(decoder.decode(plaintext)) as GitHubTokenSet;
}
