import type { SecretRedactor } from "../security/redaction.js";

/** Bounded holdback: a token split over deltas is sanitized before any prefix is emitted. */
export class StreamingModelRedactor {
  private pending = "";
  constructor(private readonly redactor: SecretRedactor) {}
  push(delta: string): string {
    this.pending += delta;
    const known = this.redactor.knownValues();
    const holdback = Math.max(256, ...known.map((value) => value.length));
    let cut = Math.max(0, this.pending.length - holdback);
    if (!cut) return "";
    for (const secret of known) {
      let start = this.pending.indexOf(secret);
      while (start !== -1) {
        if (start < cut && start + secret.length > cut) cut = start;
        start = this.pending.indexOf(secret, start + 1);
      }
    }
    // Do not split a credential assignment, auth token, URL or terminal escape.
    const sensitive =
      /\b(?:Bearer|Basic)\s+[^\s"',;]*|(?:api[-_]?key|password|secret|token|authorization)\s*[=:]\s*[^\s,;"']*|https?:\/\/[^\s<>"']*/gi;
    for (const match of this.pending.matchAll(sensitive))
      if (match.index < cut && match.index + match[0].length >= cut)
        cut = match.index;
    const escapeAt = this.pending.indexOf("\u001b");
    if (escapeAt !== -1 && escapeAt < cut) cut = escapeAt;
    if (cut && /[\uD800-\uDBFF]/.test(this.pending[cut - 1] ?? "")) cut--;
    const prefix = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    return this.redactor.text(prefix);
  }
  flush(): string {
    let text = this.pending;
    this.pending = "";
    // Cancellation/truncation can end halfway through a known secret.
    for (const secret of this.redactor.knownValues())
      for (
        let length = Math.min(secret.length - 1, text.length);
        length > 0;
        length--
      )
        if (text.endsWith(secret.slice(0, length))) {
          text = `${text.slice(0, -length)}[секрет скрыт]`;
          break;
        }
    return this.redactor.text(text);
  }
}
