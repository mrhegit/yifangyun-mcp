import { metrics } from "./observability.js";

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

export class TtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(private readonly resource: string, private readonly ttlMs: number) {}

  async getOrLoad(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      metrics.increment("cache_hit_total", { resource: this.resource });
      return cached.value;
    }
    metrics.increment("cache_miss_total", { resource: this.resource });
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = loader();
      this.inflight.set(key, pending);
    }
    try {
      const value = await pending;
      this.entries.set(key, { expiresAt: Date.now() + this.ttlMs, value });
      return value;
    } finally {
      this.inflight.delete(key);
    }
  }
}
