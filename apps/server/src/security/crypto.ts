import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export const ENCRYPTION_INFO = "crossboard-encryption-v1";

export function deriveKey(appSecret: string, info: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", appSecret, Buffer.alloc(0), info, KEY_BYTES),
  );
}

const encryptionKey = (appSecret: string) =>
  deriveKey(appSecret, ENCRYPTION_INFO);

export function encrypt(plaintext: string, appSecret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(appSecret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    VERSION,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(":");
}

export function decrypt(stored: string, appSecret: string): string {
  const parts = stored.split(":");
  const [version, iv, ciphertext, tag] = parts;
  if (
    parts.length !== 4 ||
    version !== VERSION ||
    iv === undefined ||
    ciphertext === undefined ||
    tag === undefined
  ) {
    throw new Error("the stored value is not in the v1 encrypted format");
  }
  const ivBytes = Buffer.from(iv, "base64url");
  const tagBytes = Buffer.from(tag, "base64url");
  if (ivBytes.length !== IV_BYTES || tagBytes.length !== TAG_BYTES) {
    throw new Error("the stored value is not in the v1 encrypted format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(appSecret),
    ivBytes,
  );
  decipher.setAuthTag(tagBytes);
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
