import type { JsonObject } from "./types.js";

interface Aggregate {
  count: number;
  max: number;
  sum: number;
}

class MetricRegistry {
  private readonly counters = new Map<string, number>();
  private readonly aggregates = new Map<string, Aggregate>();

  increment(name: string, labels: Record<string, string> = {}, value = 1): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.key(name, labels);
    const current = this.aggregates.get(key) ?? { count: 0, max: 0, sum: 0 };
    current.count += 1;
    current.max = Math.max(current.max, value);
    current.sum += value;
    this.aggregates.set(key, current);
  }

  snapshot(): JsonObject {
    return {
      counters: Object.fromEntries(this.counters),
      aggregates: Object.fromEntries([...this.aggregates].map(([key, value]) => [key, { ...value, average: value.count ? value.sum / value.count : 0 }]))
    } as unknown as JsonObject;
  }

  private key(name: string, labels: Record<string, string>): string {
    const suffix = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join(",");
    return suffix ? `${name}{${suffix}}` : name;
  }
}

export const metrics = new MetricRegistry();

const levelOrder = { debug: 10, info: 20, warn: 30, error: 40 } as const;
let configuredLevel: keyof typeof levelOrder = "info";

export function configureObservability(level: string): void {
  if (level === "debug" || level === "info" || level === "warn" || level === "error") {
    configuredLevel = level;
  }
}

export function logEvent(level: "debug" | "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  if (levelOrder[level] < levelOrder[configuredLevel]) {
    return;
  }
  const payload = JSON.stringify({ level, event, observed_at: new Date().toISOString(), ...fields })
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/g, "Bearer ***redacted***")
    .replace(/(access_token|refresh_token|client_secret|download_url|presign_url)(['\"\s:=]+)([^'\"\s,}]+)/gi, "$1$2***redacted***");
  console.error(payload);
}
