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
  private readonly values = new Map<symbol, unknown>();
  private readonly children = new Set<ServiceRegistry>();
  private closed = false;
  private sealed = false;
  constructor(private readonly parent?: ServiceRegistry) {
    parent?.assertOpen();
    parent?.children.add(this);
  }
  private assertOpen(): void {
    if (this.closed)
      throw new ExtensionLifecycleError("Service registry is closed.");
    this.parent?.assertOpen();
  }
  provide<T>(token: ServiceToken<T>, value: T): Disposable {
    this.assertOpen();
    if (this.sealed)
      throw new ExtensionLifecycleError("Service registrations are closed.");
    if (this.contains(token.key) || this.descendantContains(token.key))
      throw new ExtensionLifecycleError(
        `Service ${token.diagnosticId} is already registered; shadowing is not supported.`,
      );
    this.values.set(token.key, value);
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
  lookup<T>(token: ServiceToken<T>): T | undefined {
    this.assertOpen();
    if (this.values.has(token.key)) return this.values.get(token.key) as T;
    return this.parent?.lookup(token);
  }
  private descendantContains(key: symbol): boolean {
    return [...this.children].some(
      (child) => child.values.has(key) || child.descendantContains(key),
    );
  }
  get<T>(token: ServiceToken<T>): T {
    this.assertOpen();
    if (!this.contains(token.key))
      throw new ExtensionLifecycleError(
        `Required service ${token.diagnosticId} is missing. Check extension activation order.`,
      );
    return this.lookup(token) as T;
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
