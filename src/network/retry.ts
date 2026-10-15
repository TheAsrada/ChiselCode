/** Retry-After is a server deadline, not a delay that may be shortened. */
export function retryAfterMs(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value?.trim()) return;
  const text = value.trim();
  const duration = /^\d+$/.test(text)
    ? Number(text) * 1000
    : Date.parse(text) - now;
  return Number.isFinite(duration) ? Math.max(0, duration) : undefined;
}
