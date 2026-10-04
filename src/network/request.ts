import {
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { ConnectionOptions } from "node:tls";
import { HttpsProxyAgent } from "https-proxy-agent";
import { type NetworkTls, proxyForUrl } from "./environment.js";

export type NetworkRequestOptions = RequestOptions &
  Pick<
    ConnectionOptions,
    | "ca"
    | "cert"
    | "key"
    | "passphrase"
    | "servername"
    | "rejectUnauthorized"
    | "checkServerIdentity"
  > & {
    proxyTls?: NetworkTls;
    proxySignal?: AbortSignal;
  };

/** Origin and proxy TLS identities are separate; auth is confined to CONNECT. */
export function networkRequest(
  url: URL,
  options: NetworkRequestOptions,
  response: (incoming: IncomingMessage) => void,
) {
  const proxy = proxyForUrl(url);
  const agent = proxy
    ? new HttpsProxyAgent(proxy, {
        ...options.proxyTls,
        signal: options.proxySignal,
        keepAlive: false,
      })
    : undefined;
  const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
    { ...options, agent: agent ?? false },
    response,
  );
  if (agent) request.once("close", () => setImmediate(() => agent.destroy()));
  return request;
}
