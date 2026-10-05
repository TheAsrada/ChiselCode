import { Client, type JSONRPCResponse } from "@modelcontextprotocol/client";

/** Preserve progress-before-response ordering when a transport batches messages. */
export class McpSdkClient extends Client {
  protected override _onresponse(response: JSONRPCResponse): void {
    // SDK 2.3 queues notification handlers but settles responses synchronously.
    // A coalesced response would delete the progress callback before it runs.
    // Use the documented subclass boundary, leaving decoding and routing to SDK.
    queueMicrotask(() => super._onresponse(response));
  }
}
