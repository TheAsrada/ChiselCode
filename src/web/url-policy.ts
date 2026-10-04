import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { cancelled, RuntimeError } from "../runtime/errors.js";

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type AddressResolver = (hostname: string) => Promise<ResolvedAddress[]>;
export interface ResolvedUrl {
  url: URL;
  addresses: ResolvedAddress[];
}
const systemResolver: AddressResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((r) => ({
    address: r.address,
    family: r.family as 4 | 6,
  }));
export function publicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}
export function urlHostname(url: URL): string {
  return url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}
export class UrlPolicy {
  constructor(private readonly resolver: AddressResolver = systemResolver) {}
  normalize(input: string): URL {
    if (input.length > 4096)
      throw new RuntimeError(
        "WEB_TOO_LARGE",
        "Public web URLs are limited to 4096 characters.",
        { retryable: false },
      );
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new RuntimeError(
        "INVALID_TOOL_INPUT",
        "Expected an absolute HTTP or HTTPS URL.",
      );
    }
    const hostname = urlHostname(url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      (url.port && !["80", "443"].includes(url.port))
    )
      throw new RuntimeError(
        "WEB_UNSAFE_ADDRESS",
        "Only public HTTP/HTTPS URLs on ports 80 or 443 without embedded credentials are allowed.",
      );
    if (
      !hostname ||
      hostname === "localhost" ||
      hostname === "metadata" ||
      hostname === "instance-data" ||
      /\.(?:localhost|local|localdomain|internal|home\.arpa)$/.test(hostname) ||
      (!hostname.includes(".") && !isIP(hostname)) ||
      (isIP(hostname) && !publicAddress(hostname))
    )
      throw new RuntimeError(
        "WEB_UNSAFE_ADDRESS",
        "Local, private, reserved and metadata addresses are blocked, including in Bypass.",
      );
    for (const key of url.searchParams.keys())
      if (
        /^(?:api[-_]?key|access[-_]?token|token|password|secret|authorization)$/i.test(
          key,
        )
      )
        throw new RuntimeError(
          "WEB_UNSAFE_ADDRESS",
          "Public web tools do not accept credentials in URL parameters.",
        );
    url.hash = "";
    if (!isIP(hostname)) url.hostname = hostname;
    if (url.toString().length > 4096)
      throw new RuntimeError(
        "WEB_TOO_LARGE",
        "The normalized public web URL exceeds 4096 characters.",
        { retryable: false },
      );
    return url;
  }
  async resolve(input: string, signal?: AbortSignal): Promise<ResolvedUrl> {
    cancelled(signal);
    const url = this.normalize(input);
    const hostname = urlHostname(url);
    let addresses: ResolvedAddress[];
    try {
      addresses = isIP(hostname)
        ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
        : await abortableResolution(this.resolver(hostname), signal);
    } catch (error) {
      cancelled(signal);
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError(
        "WEB_FETCH_FAILED",
        "Could not resolve the public web hostname.",
        { retryable: true },
      );
    }
    cancelled(signal);
    if (
      !addresses.length ||
      addresses.length > 64 ||
      addresses.some(
        (r) =>
          ![4, 6].includes(r.family) ||
          isIP(r.address) !== r.family ||
          !publicAddress(r.address),
      )
    )
      throw new RuntimeError(
        "WEB_UNSAFE_ADDRESS",
        "DNS returned a private, reserved or unsafe address; no connection was made.",
        { retryable: false },
      );
    return { url, addresses };
  }
}
async function abortableResolution<T>(
  task: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return task;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        abort = () =>
          reject(new RuntimeError("CANCELLED", "DNS lookup cancelled."));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
