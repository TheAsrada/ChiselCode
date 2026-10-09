export const SENSITIVE_KEY =
  /(?:secret|token|password|passwd|credential|api[-_]?key|authorization|cookie|database_url|private[-_]?key|signature|^sig$|^key$)/i;

/** Known credential values are removed before results, artifacts, events and storage. */
export class SecretRedactor {
  private values = new Set<string>();
  constructor(private readonly sensitiveFields = true) {}
  add(value: string): void {
    if (!value) return;
    this.values.add(value);
    this.values.add(encodeURIComponent(value));
    this.values.add(JSON.stringify(value).slice(1, -1));
    this.values.add(Buffer.from(value).toString("base64"));
  }
  /** Core stream framing only; never exposed through an extension context. */
  knownValues(): readonly string[] {
    return [...this.values];
  }
  text(value: string): string {
    let text = value;
    for (const secret of [...this.values].sort((a, b) => b.length - a.length))
      text = text.split(secret).join("[секрет скрыт]");
    if (this.sensitiveFields)
      text = text
        .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, "$1 [секрет скрыт]")
        .replace(
          /((?:api[-_]?key|password|secret|token|authorization)\s*[=:]\s*)([^\s,;"']+)/gi,
          "$1[секрет скрыт]",
        )
        .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
          try {
            const url = new URL(raw);
            let changed = false;
            if (url.username || url.password) {
              url.username = "hidden";
              url.password = "hidden";
              changed = true;
            }
            for (const key of url.searchParams.keys())
              if (SENSITIVE_KEY.test(key)) {
                url.searchParams.set(key, "[секрет скрыт]");
                changed = true;
              }
            return changed ? url.toString() : raw;
          } catch {
            return "[адрес скрыт]";
          }
        });
    return (
      text
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip untrusted terminal escapes.
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Preserve text newlines, never terminal control bytes.
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    );
  }
  value<T>(value: T): T {
    if (typeof value === "string") return this.text(value) as T;
    if (Array.isArray(value)) return value.map((item) => this.value(item)) as T;
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value))
        result[key] =
          this.sensitiveFields &&
          SENSITIVE_KEY.test(key) &&
          typeof item === "string"
            ? "[секрет скрыт]"
            : this.value(item);
      return result as T;
    }
    return value;
  }
}
