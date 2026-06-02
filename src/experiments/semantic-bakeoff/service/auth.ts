/**
 * Hosted auth abstraction for the data plane (R&D). The server derives the tenant
 * from a VERIFIED PRINCIPAL (the Authorization header), NEVER from the request
 * body — a body-supplied tenant would be a trivial spoof. Real deployments plug a
 * JWT/mTLS authenticator here; tests use FakeAuthenticator only.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export interface Principal {
  tenant: string;
}

export interface Authenticator {
  /** Verify the request's credentials → principal, or null to reject (401). */
  authenticate(headers: Record<string, string | string[] | undefined>): Principal | null;
}

/** TEST-ONLY authenticator: a fixed bearer-token → tenant table. Never for prod. */
export class FakeAuthenticator implements Authenticator {
  constructor(private readonly tokenToTenant: Record<string, string>) {}
  authenticate(headers: Record<string, string | string[] | undefined>): Principal | null {
    const raw = headers["authorization"];
    const auth = Array.isArray(raw) ? raw[0] : raw;
    const m = /^Bearer (.+)$/.exec(String(auth ?? ""));
    if (!m) return null;
    const tenant = this.tokenToTenant[m[1]!];
    return tenant ? { tenant } : null;
  }
}

/**
 * Single-tenant sidecar auth. Stores only a one-way digest of the configured
 * bearer token and compares fixed-size digests in constant time. Hosted mode
 * plugs in JWT/mTLS separately; this class is for a customer-managed endpoint.
 */
export class StaticBearerAuthenticator implements Authenticator {
  private readonly expectedDigest: Buffer;
  private readonly tenant: string;

  constructor(token: string, tenant: string) {
    if (token.length < 16) throw new Error("semantic sidecar bearer token must be at least 16 characters");
    if (!tenant.trim()) throw new Error("semantic sidecar tenant must be non-empty");
    this.expectedDigest = createHash("sha256").update(token).digest();
    this.tenant = tenant.trim();
  }

  authenticate(headers: Record<string, string | string[] | undefined>): Principal | null {
    const raw = headers["authorization"];
    const auth = Array.isArray(raw) ? raw[0] : raw;
    const match = /^Bearer (.+)$/.exec(String(auth ?? ""));
    if (!match) return null;
    const actual = createHash("sha256").update(match[1]!).digest();
    return timingSafeEqual(actual, this.expectedDigest) ? { tenant: this.tenant } : null;
  }
}

/**
 * Per-tenant token-bucket quota. BOUNDED: the bucket map is an LRU capped at
 * `maxTenants`, so an attacker rotating tenant ids cannot grow it without bound
 * (oldest buckets evict; an evicted tenant simply starts with a full burst again).
 */
export class TenantQuota {
  private readonly buckets = new Map<string, { tokens: number; last: number }>();
  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
    private readonly maxTenants: number = 10_000,
  ) {}
  allow(tenant: string): boolean {
    const t = this.now();
    let b = this.buckets.get(tenant);
    this.buckets.delete(tenant); // touch → MRU
    if (!b) b = { tokens: this.burst, last: t };
    b.tokens = Math.min(this.burst, b.tokens + ((t - b.last) / 1000) * this.ratePerSec);
    b.last = t;
    this.buckets.set(tenant, b);
    while (this.buckets.size > this.maxTenants) {
      const oldest = this.buckets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
  /** Current bucket count — bounded by maxTenants. */
  size(): number {
    return this.buckets.size;
  }
}
