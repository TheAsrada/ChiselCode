import { cancelled } from "../../runtime/errors.js";
import { canonicalPath, inspectPackage } from "../external/package.js";
import type { ExtensionRecord, ManagedRecord } from "../external/registry.js";
import {
  readExtensionRegistry,
  receiptMatches,
  runtimeRecord,
  selectedVersion,
  withExtensionRegistry,
} from "../external/registry.js";
import { ExtensionSettingsStore } from "../settings-store.js";

export function sameRuntime(
  record: ExtensionRecord,
  current?: ExtensionRecord,
) {
  return (
    !!current?.enabled &&
    record.digest === current.digest &&
    record.version === current.version &&
    record.entry === current.entry &&
    record.approvedAt === current.approvedAt &&
    canonicalPath(record.location) === canonicalPath(current.location)
  );
}

export async function activationPlan(record: ExtensionRecord) {
  const row = (await readExtensionRegistry()).records.find(
    ({ id }) => id === record.id,
  );
  return row && sameRuntime(record, runtimeRecord(row)) ? row : undefined;
}

/** Only the exact requested row may be confirmed or reverted. */
export async function settlePackageActivation(
  expected: ManagedRecord,
  success: boolean,
  signal?: AbortSignal,
  publish?: () => void,
): Promise<ExtensionRecord | undefined> {
  return withExtensionRegistry(async (registry, _assertOwned, save) => {
    const row = registry.records.find(({ id }) => id === expected.id);
    if (!row?.enabled || row.removedAt || row.selected !== expected.selected)
      return;
    const requested = runtimeRecord(row)!;
    if (row.revision !== expected.revision) {
      if (
        success &&
        row.lastWorking === row.selected &&
        sameRuntime(requested, runtimeRecord(expected)) &&
        row.revision === expected.revision + 1 &&
        expected.lastWorking !== expected.selected
      ) {
        cancelled(signal);
        publish?.();
        return requested;
      }
      return;
    }
    cancelled(signal);
    const version = success
      ? selectedVersion(row)
      : row.versions.find(
          ({ key }) => key === row.lastWorking && key !== row.selected,
        );
    if (!version) return;
    const record = runtimeRecord(row, version)!;
    const inspected = await inspectPackage(record.location, signal).catch(
      () => undefined,
    );
    if (
      !inspected ||
      inspected.incompatible ||
      !receiptMatches(record, inspected)
    )
      return;
    if (
      !success &&
      (await new ExtensionSettingsStore(inspected.manifest).read()).issues
        .length
    )
      return;
    cancelled(signal);
    if (success && row.lastWorking === row.selected) {
      publish?.();
      return record;
    }
    if (success) row.lastWorking = row.selected;
    else {
      row.failedVersion = requested.version;
      row.selected = version.key;
    }
    row.revision++;
    registry.revision++;
    await save();
    publish?.();
    return record;
  });
}

export async function withActivePackage<T>(
  record: ExtensionRecord,
  claim: () => Promise<T>,
): Promise<T | undefined> {
  return withExtensionRegistry((registry) => {
    const row = registry.records.find(({ id }) => id === record.id);
    if (!row || !sameRuntime(record, runtimeRecord(row)))
      return Promise.resolve(undefined);
    return claim();
  });
}
