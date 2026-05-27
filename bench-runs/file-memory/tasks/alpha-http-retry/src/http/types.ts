export interface RequestOptions {
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  timeoutMs?: number;
}

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  /** Backoff growth factor per attempt (2.0 = exponential doubling). */
  factor: number;
  /** Max delay clamp; null = unbounded. */
  maxDelayMs?: number;
}

export interface HttpResponse {
  status: number;
  body: unknown;
  attempts: number;
}
