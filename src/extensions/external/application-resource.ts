import type { ChiselExtension, Disposable } from "../contracts.js";

// Private composition provenance; external JSON/SDK definitions cannot create it.
export interface ApplicationResource extends Disposable {
  dispose(cleanupConfirmed?: boolean): void | Promise<void>;
}
const resources = new WeakMap<object, ApplicationResource>();
export function setApplicationResource(
  definition: ChiselExtension,
  resource: ApplicationResource,
): void {
  resources.set(definition, resource);
}
export function applicationResource(
  definition: ChiselExtension,
): ApplicationResource | undefined {
  return resources.get(definition);
}
