import { NetworkConfigurationError } from "./environment.js";
import { networkFetch } from "./node-fetch.js";

/** Shared SDK transport. Public web tools additionally pin DNS and validate every redirect. */
export async function enterpriseFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  let request = new Request(input, init);
  for (let count = 0; ; count++) {
    const url = new URL(request.url);
    const response = await networkFetch(request.clone());
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (request.redirect === "manual") return response;
    const location = response.headers.get("location");
    if (!location) return response;
    await response.body?.cancel();
    if (request.redirect === "error" || count >= 10)
      throw new NetworkConfigurationError(
        "Network redirect refused or redirect limit reached.",
      );
    let destination: URL;
    try {
      destination = new URL(location, url);
      if (
        !["http:", "https:"].includes(destination.protocol) ||
        destination.username ||
        destination.password
      )
        throw new Error();
    } catch {
      throw new NetworkConfigurationError(
        "The server returned an unsafe redirect address.",
      );
    }
    const headers = new Headers(request.headers);
    if (destination.origin !== url.origin) {
      for (const name of [
        "authorization",
        "cookie",
        "proxy-authorization",
        "x-api-key",
      ])
        headers.delete(name);
    }
    const toGet =
      (response.status === 303 && !["GET", "HEAD"].includes(request.method)) ||
      ([301, 302].includes(response.status) && request.method === "POST");
    if (toGet) {
      for (const name of [
        "content-type",
        "content-length",
        "transfer-encoding",
      ])
        headers.delete(name);
    }
    request = new Request(destination, {
      method: toGet ? "GET" : request.method,
      headers,
      signal: request.signal,
      redirect: request.redirect,
      ...(toGet || ["GET", "HEAD"].includes(request.method)
        ? {}
        : { body: request.clone().body }),
    });
  }
}
