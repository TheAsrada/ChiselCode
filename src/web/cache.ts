import type { WebDocument } from "./content.js";

/** Bounded session cache of extracted text, never raw HTML or credential-bearing requests. */
export class WebSessionCache {
  private entries = new Map<
    string,
    { value: WebDocument; expires: number; size: number }
  >();
  private aliases = new Map<string, string>();
  private size = 0;
  constructor(
    private readonly maxBytes = 2 * 1024 * 1024,
    private readonly maxEntries = 16,
    private readonly clock = Date.now,
  ) {}
  get(url: string): WebDocument | undefined {
    const key = this.aliases.get(url) ?? url;
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.expires <= this.clock()) {
      this.remove(key);
      return;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { ...entry.value, requestedUrl: url };
  }
  put(value: WebDocument, ttlMs: number): void {
    if (ttlMs <= 0) return;
    const size = Buffer.byteLength(JSON.stringify(value));
    if (size > this.maxBytes) return;
    this.remove(value.finalUrl);
    this.entries.set(value.finalUrl, {
      value: { ...value },
      size,
      expires: this.clock() + ttlMs,
    });
    this.size += size;
    for (const alias of [
      value.requestedUrl,
      ...value.redirects,
      value.finalUrl,
    ])
      this.aliases.set(alias, value.finalUrl);
    while (this.size > this.maxBytes || this.entries.size > this.maxEntries)
      this.remove(this.entries.keys().next().value as string);
  }
  private remove(key: string): void {
    this.size -= this.entries.get(key)?.size ?? 0;
    this.entries.delete(key);
    for (const [alias, target] of this.aliases)
      if (target === key) this.aliases.delete(alias);
  }
}
const sessionCaches = new Map<string, WebSessionCache>();
export function webSessionCache(scope: string): WebSessionCache {
  const cache = sessionCaches.get(scope) ?? new WebSessionCache();
  sessionCaches.delete(scope);
  sessionCaches.set(scope, cache);
  while (sessionCaches.size > 16)
    sessionCaches.delete(sessionCaches.keys().next().value as string);
  return cache;
}
