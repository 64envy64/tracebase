import type { HttpResponse, RequestOptions, RetryConfig } from "./types.js";
import { withRetry } from "./retry.js";

const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 4,
  baseDelayMs: 100,
  factor: 2,
};

/**
 * High-level HTTP client. Wraps the transport in a retry loop.
 */
export class HttpClient {
  constructor(
    private transport: (opts: RequestOptions) => Promise<HttpResponse>,
    private retry: RetryConfig = DEFAULT_RETRY,
  ) {}

  async send(opts: RequestOptions): Promise<HttpResponse> {
    const result = await withRetry(async () => {
      const r = await this.transport(opts);
      if (r.status >= 500) throw new Error(`transient ${r.status}`);
      return r;
    }, this.retry);
    return { ...result.value, attempts: result.attempts };
  }
}
