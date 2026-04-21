import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_KIND = "tb_live";

export function generateApiKeyMaterial() {
  const id = `tbk_${randomBytes(6).toString("hex")}`;
  const secret = randomBytes(18).toString("base64url");
  const salt = randomBytes(16).toString("base64url");
  const secretHash = hashApiKeySecret(secret, salt);

  return {
    id,
    value: `${KEY_KIND}_${id}_${secret}`,
    prefix: `${KEY_KIND}_${id}`,
    last4: secret.slice(-4),
    salt,
    secretHash,
  };
}

export function parseApiKey(value: string): { id: string; secret: string } | null {
  const trimmed = value.trim();
  const match = /^tb_live_(tbk_[a-f0-9]{12})_([A-Za-z0-9\-_]+)$/.exec(trimmed);
  if (!match) return null;
  return {
    id: match[1],
    secret: match[2],
  };
}

export function hashApiKeySecret(secret: string, salt: string): string {
  return scryptSync(secret, salt, 32).toString("hex");
}

export function verifyApiKeySecret(secret: string, salt: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashApiKeySecret(secret, salt), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
