/** Internal linked-code API. This is not a public SDK or a user plugin loader. */

export { defineTool } from "../tools/handler.js";
export { defaultExtensions } from "./composition.js";
export type {
  ChiselExtension,
  ContextProviderSnapshot,
  Disposable,
  ExtensionCommandContribution,
  ExtensionCommandDescriptor,
  ExtensionCommandIdentity,
  ExtensionCommandInvocation,
  ExtensionContext,
  ExtensionToolContribution,
  ToolGuardSnapshot,
} from "./contracts.js";
export { ExtensionHost, type WorkspaceExtensionScope } from "./host.js";
export {
  createServiceToken,
  ServiceRegistry,
  type ServiceToken,
} from "./services.js";
export { attachExtensionTools } from "./tools.js";
