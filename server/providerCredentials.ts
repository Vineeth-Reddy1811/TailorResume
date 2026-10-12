import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const keyVersion = 1;

function encryptionKey(): Buffer {
  const encoded = process.env.AI_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!encoded) throw new Error("AI provider connections are not configured.");
  const key = /^[0-9a-f]{64}$/i.test(encoded)
    ? Buffer.from(encoded, "hex")
    : Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("AI provider connections are not configured.");
  return key;
}

function additionalData(userId: string, provider: string, version: number): Buffer {
  return Buffer.from(`tailorresume:${userId}:${provider}:v${version}`, "utf8");
}

export interface EncryptedProviderCredential {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

export function encryptProviderCredential(userId: string, provider: string, credential: string): EncryptedProviderCredential {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(additionalData(userId, provider, keyVersion));
  const ciphertext = Buffer.concat([cipher.update(credential, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion,
  };
}

export function decryptProviderCredential(
  userId: string,
  provider: string,
  credential: EncryptedProviderCredential,
): string {
  if (credential.keyVersion !== keyVersion) throw new Error("The saved AI provider credential needs an encryption-key migration.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(credential.iv, "base64"));
  decipher.setAAD(additionalData(userId, provider, credential.keyVersion));
  decipher.setAuthTag(Buffer.from(credential.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(credential.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
