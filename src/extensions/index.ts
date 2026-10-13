/** Internal linked-code API. This is not a public SDK or a user plugin loader. */

export type {
  ModelRequestEvent,
  ModelRequestInput,
  ModelRequestPort,
  ModelRequestResult,
} from "../models/contracts.js";
export type { ThemeContribution, ThemeToken } from "../themes/contracts.js";
export { defineTool } from "../tools/handler.js";
export type {
  ChatCard,
  ChatPresentation,
  ChatStyle,
} from "../types/chat-presentation.js";
export { applicationExtensions, defaultExtensions } from "./composition.js";
export type {
  ChiselExtension,
  ContextProviderSnapshot,
  Disposable,
  ExtensionChatView,
  ExtensionCommandContribution,
  ExtensionCommandDescriptor,
  ExtensionCommandIdentity,
  ExtensionCommandInvocation,
  ExtensionContext,
  ExtensionToolContribution,
  SideQueryCommandInvocation,
  ToolGuardSnapshot,
} from "./contracts.js";
export { ExtensionHost, type WorkspaceExtensionScope } from "./host.js";
export {
  createServiceToken,
  ServiceRegistry,
  type ServiceToken,
} from "./services.js";
export { attachExtensionTools } from "./tools.js";
export { ExtensionUiRegistry, UiSubscription } from "./ui.js";
export type {
  OwnedUiContribution,
  UiAction,
  UiActionUse,
  UiBinding,
  UiContribution,
  UiDetailsPage,
  UiDetailsView,
  UiOwnerSummary,
  UiRow,
  UiSnapshot,
  UiSource,
  UiTone,
} from "./ui-types.js";
export {
  UiActionUseSchema,
  UiDetailsPageSchema,
  UiRowSchema,
  UiSnapshotSchema,
} from "./ui-types.js";
