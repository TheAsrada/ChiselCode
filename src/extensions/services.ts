import type { ExtensionActivation } from "./activation.js";
import type { Disposable } from "./contracts.js";
import { ExtensionLifecycleError, validateId } from "./lifecycle.js";

const serviceType: unique symbol = Symbol("service type");
export interface ServiceToken<T> {
  readonly key: symbol;
  readonly diagnosticId: string;
  /** Invariant in T; the diagnostic string does not identify a contract. */
  readonly [serviceType]: (value: T) => T;
}
export function createServiceToken<T>(diagnosticId: string): ServiceToken<T> {
  validateId(diagnosticId, "service");
  return Object.freeze({
    key: Symbol(diagnosticId),
    diagnosticId,
    [serviceType]: (value: T) => value,
  });
}

/** Owns registrations only. Service resource ownership is explicit in ctx.add(). */
export class ServiceRegistry implements Disposable {
  private readonly values = new Map<
    symbol,
    { value: unknown; owner?: ExtensionActivation }
  >();
  private readonly children = new Set<ServiceRegistry>();
  private closed = false;
  private sealed = false;
  constructor(
    private readonly parent?: ServiceRegistry,
    private readonly staging = () => false,
  ) {
    parent?.assertOpen();
    parent?.children.add(this);
  }
  private assertOpen(): void {
    if (this.closed)
      throw new ExtensionLifecycleError("Service registry is closed.");
    this.parent?.assertOpen();
  }
  provide<T>(
    token: ServiceToken<T>,
    value: T,
    owner?: ExtensionActivation,
  ): Disposable {
    this.assertOpen();
    if (this.sealed && !this.staging())
      throw new ExtensionLifecycleError("Service registrations are closed.");
    if (this.contains(token.key) || this.descendantContains(token.key))
      throw new ExtensionLifecycleError(
        `Service ${token.diagnosticId} is already registered; shadowing is not supported.`,
      );
    this.values.set(token.key, { value, owner });
    let removed = false;
    return {
      dispose: () => {
        if (!removed) {
          removed = true;
          this.values.delete(token.key);
        }
      },
    };
  }
  private contains(key: symbol): boolean {
    this.assertOpen();
    return this.values.has(key) || (this.parent?.contains(key) ?? false);
  }
  private visible(
    key: symbol,
    requester?: ExtensionActivation,
  ): { value: unknown } | undefined {
    this.assertOpen();
    const entry = this.values.get(key);
    if (!entry) return this.parent?.visible(key, requester);
    if (
      !entry.owner ||
      entry.owner.available ||
      (entry.owner === requester && !requester.signal.aborted)
    )
      return entry;
  }
  lookup<T>(
    token: ServiceToken<T>,
    requester?: ExtensionActivation,
  ): T | undefined {
    return this.visible(token.key, requester)?.value as T | undefined;
  }
  private descendantContains(key: symbol): boolean {
    return [...this.children].some(
      (child) => child.values.has(key) || child.descendantContains(key),
    );
  }
  get<T>(token: ServiceToken<T>, requester?: ExtensionActivation): T {
    const entry = this.visible(token.key, requester);
    if (!entry)
      throw new ExtensionLifecycleError(
        `Required service ${token.diagnosticId} is missing. Check extension activation order.`,
      );
    return entry.value as T;
  }
  child(): ServiceRegistry {
    this.assertOpen();
    return new ServiceRegistry(this);
  }
  seal(): void {
    this.sealed = true;
  }
  dispose(): void {
    this.closed = true;
    this.values.clear();
    this.children.clear();
    this.parent?.children.delete(this);
  }
}
