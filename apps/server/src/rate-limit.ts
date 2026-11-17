// Small in-memory sliding-window limiter. One server instance only; good enough to stop catch spamming.

const hits = new Map<string, number[]>();

export function rateLimited(key: string, limit: number, windowMs: number, now = Date.now()) {
  const recent = (hits.get(key) ?? []).filter((time) => now - time < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  return false;
}

export function resetRateLimits() {
  hits.clear();
}

// Keep the map from growing forever.
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of hits) {
    if (times.every((time) => now - time > 10 * 60_000)) hits.delete(key);
  }
}, 5 * 60_000).unref();
