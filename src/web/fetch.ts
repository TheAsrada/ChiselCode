import { cancelled } from "../runtime/errors.js";
import type { WebSessionCache } from "./cache.js";
import { extractDocument, textLimit, type WebDocument } from "./content.js";
import type { SafeWebHttpClient, WebHttpOptions } from "./http-client.js";
import type { WebConfig } from "./schema.js";
import { urlHostname } from "./url-policy.js";

export class WebFetchService {
  constructor(
    private readonly http: SafeWebHttpClient,
    private readonly config: WebConfig,
    private readonly cache: WebSessionCache,
  ) {}
  async fetch(
    url: string,
    maxChars: number,
    options: WebHttpOptions,
  ): Promise<{ document: WebDocument; cached: boolean }> {
    cancelled(options.signal);
    const normalized = this.http.policy.normalize(url).toString();
    options.authorization.assertDestination(urlHostname(new URL(normalized)));
    const cached =
      this.config.cacheTtlMs > 0 ? this.cache.get(normalized) : undefined;
    if (
      cached &&
      Date.now() - Date.parse(cached.fetchedAt) < this.config.cacheTtlMs
    ) {
      // Previously allowed redirects do not authorize a domain after its permission is revoked.
      for (const target of [...cached.redirects, cached.finalUrl])
        options.authorization.assertDestination(
          urlHostname(this.http.policy.normalize(target)),
        );
      return { document: this.bounded(cached, maxChars), cached: true };
    }
    const response = await this.http.get(normalized, options);
    cancelled(options.signal);
    const document = extractDocument(
      response,
      this.config.limits.maxExtractedChars,
    );
    this.cache.put(document, this.config.cacheTtlMs);
    return { document: this.bounded(document, maxChars), cached: false };
  }
  private bounded(document: WebDocument, maxChars: number): WebDocument {
    const limit = Math.min(maxChars, this.config.limits.maxExtractedChars);
    return {
      ...document,
      text: textLimit(document.text, limit),
      truncated: document.truncated || document.text.length > limit,
    };
  }
}
