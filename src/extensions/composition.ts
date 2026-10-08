import { cancelled } from "../runtime/errors.js";
import { createLspExtension } from "./builtins/lsp.js";
import { projectExtension } from "./builtins/project.js";
import type { ChiselExtension, ContextCollectionPort } from "./contracts.js";
import {
  canonicalWorkspaceRoot,
  ExtensionHost,
  type WorkspaceExtensionScope,
} from "./host.js";
import {
  abortable,
  ExtensionLifecycleError,
  operationSignal,
} from "./lifecycle.js";

/** Internal composition dependency, not persisted settings or a CLI option. */
export type ExtensionDependencies =
  | { scope: WorkspaceExtensionScope }
  | { host: ExtensionHost }
  | { extensions: readonly ChiselExtension[] };

/** Explicit application defaults; an ExtensionHost([]) still has no definitions. */
export function defaultExtensions(
  custom: readonly ChiselExtension[] = [],
  options: { configPath?: string } = {},
): readonly ChiselExtension[] {
  return [projectExtension, createLspExtension(options), ...custom];
}

export async function withOwnedExtensionHost<T>(
  definitions: readonly ChiselExtension[],
  work: (host: ExtensionHost) => Promise<T>,
): Promise<T> {
  const host = new ExtensionHost(definitions);
  let result!: T;
  let failed = false;
  let primary: unknown;
  let cleanupFailed = false;
  let cleanupError: unknown;
  try {
    result = await work(host);
  } catch (error) {
    failed = true;
    primary = error;
  } finally {
    try {
      await host.dispose();
    } catch (cleanup) {
      cleanupFailed = true;
      cleanupError = cleanup;
    }
  }
  if (cleanupFailed) {
    if (!failed) throw cleanupError;
    throw new ExtensionLifecycleError(
      `${primary instanceof ExtensionLifecycleError ? primary.message : "Application operation failed."} Extension cleanup also failed.`,
      primary instanceof ExtensionLifecycleError
        ? primary.extensionId
        : undefined,
      primary,
      cleanupError instanceof ExtensionLifecycleError
        ? cleanupError.cleanupFailures
        : [],
    );
  }
  if (failed) throw primary;
  return result;
}

export async function withExtensionWorkspace<T>(
  root: string,
  dependencies: ExtensionDependencies | undefined,
  signal: AbortSignal | undefined,
  work: (scope: WorkspaceExtensionScope, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const borrowed = async (
    dependency: { host: ExtensionHost } | { scope: WorkspaceExtensionScope },
  ) => {
    cancelled(signal);
    const scope =
      "scope" in dependency
        ? dependency.scope
        : await abortable(() => dependency.host.open(root), signal);
    scope.assertUsable();
    if (
      "scope" in dependency &&
      scope.workspaceRoot !== (await canonicalWorkspaceRoot(root))
    )
      throw new ExtensionLifecycleError(
        "Borrowed extension scope belongs to a different workspace.",
      );
    scope.assertUsable();
    const operation = operationSignal(scope.signal, signal);
    cancelled(operation);
    return work(scope, operation);
  };
  if (dependencies && !("extensions" in dependencies))
    return borrowed(dependencies);
  return withOwnedExtensionHost(dependencies?.extensions ?? [], (host) =>
    borrowed({ host }),
  );
}

export function contextCollection(
  scope: WorkspaceExtensionScope,
  sanitize: (text: string) => string,
): ContextCollectionPort {
  scope.assertUsable();
  return {
    collect: (invocation, signal) =>
      scope.contextProviders.collect(invocation, signal, sanitize),
  };
}
