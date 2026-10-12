import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ChiselExtension,
  type ExtensionContext,
  ExtensionHost,
  type OwnedUiContribution,
  type UiBinding,
} from "../../src/extensions/index.js";
import { sanitizeUi } from "../../src/extensions/ui.js";
import { UiSnapshotSchema } from "../../src/extensions/ui-types.js";
import { SecretRedactor } from "../../src/security/redaction.js";
import { uiExtension } from "../fixtures/ui-extension.js";

function owner(
  id: string,
  signal = new AbortController().signal,
): Omit<UiBinding, "workspaceRoot" | "scopeInstance"> {
  return {
    conversationId: id,
    generation: 1,
    signal,
    read: {
      ownerSummary: () => ({
        background: {
          active: id === "one" ? 1 : 2,
          errors: 0,
          awaitingApproval: 0,
        },
        agents: { active: 0, total: 0, errors: 0 },
      }),
      subscribeOwner: () => ({ dispose() {} }),
    },
  };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("UI snapshot did not settle");
    await Bun.sleep(10);
  }
}
test("UI registers are sealed, captured, independently namespaced and closed with their scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-ui-"));
  let saved!: ExtensionContext;
  const descriptor = {
    id: "same",
    slot: "status" as const,
    scope: "conversation" as const,
    title: "Исходное имя",
    source: { snapshot: () => ({ revision: 0, state: "ready" as const }) },
  };
  const host = new ExtensionHost([
    {
      id: "a",
      activate(ctx) {
        saved = ctx;
        ctx.ui.register(descriptor);
        descriptor.title = "Подменено";
      },
    },
    {
      id: "b",
      activate(ctx) {
        ctx.ui.register({ ...descriptor, title: "Другой владелец" });
      },
    },
  ]);
  try {
    const scope = await host.open(root);
    expect(scope.ui.descriptors().map((item) => item.descriptor.title)).toEqual(
      ["Исходное имя", "Другой владелец"],
    );
    expect(() => saved.ui.register(descriptor)).toThrow(
      "registrations are closed",
    );
    let items: readonly OwnedUiContribution[] = [];
    const subscription = scope.ui.bind(owner("one"), (value) => {
      items = value;
    });
    await until(() => items.every((item) => item.snapshot.state === "ready"));
    expect(Object.isFrozen(items[0]?.snapshot)).toBe(true);
    await host.dispose();
    expect(subscription.isLive()).toBe(false);
    expect(() => scope.ui.descriptors()).toThrow();
  } finally {
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
test("duplicate metadata and failed activation roll back UI registrations and reverse cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-ui-rollback-"));
  const cleaned: string[] = [];
  const extension: ChiselExtension = {
    id: "a",
    activate(ctx) {
      ctx.add({
        dispose() {
          cleaned.push("first");
        },
      });
      ctx.ui.register({
        id: "same",
        slot: "status",
        scope: "workspace",
        title: "Имя",
        source: { snapshot: () => ({ revision: 0, state: "empty" }) },
      });
      ctx.add({
        dispose() {
          cleaned.push("second");
          throw new Error("cleanup fault");
        },
      });
      ctx.ui.register({
        id: "same",
        slot: "status",
        scope: "workspace",
        title: "Дубликат",
        source: { snapshot: () => ({ revision: 0, state: "empty" }) },
      });
    },
  };
  const host = new ExtensionHost([extension]);
  try {
    await expect(host.open(root)).rejects.toThrow();
    expect(host.readyScopes()).toHaveLength(0);
    expect(cleaned).toEqual(["second", "first"]);
  } finally {
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
test("owner caches, late acquisitions, monotonic revisions and source errors remain isolated", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-ui-owner-"));
  let revision = 2;
  let fail = false;
  let notify: () => void = () => {};
  let release: ((value: unknown) => void) | undefined;
  const seen: UiBinding[] = [];
  const host = new ExtensionHost([
    {
      id: "owner",
      activate(ctx) {
        ctx.ui.register({
          id: "state",
          slot: "status",
          scope: "conversation",
          title: "Владелец",
          source: {
            snapshot(binding) {
              seen.push(binding);
              if (fail) throw new Error("secret=hidden");
              return {
                revision,
                state: "ready",
                count: binding.read.ownerSummary().background.active,
              };
            },
            subscribe(_binding, changed) {
              notify = changed;
              return { dispose() {} };
            },
          },
        });
        ctx.ui.register({
          id: "late",
          slot: "context_section",
          scope: "workspace",
          title: "Поздний",
          source: {
            snapshot: (binding) => {
              expect(binding.conversationId).toBeUndefined();
              return new Promise((resolve) => {
                release = resolve as typeof release;
              });
            },
          },
        });
      },
    },
  ]);
  try {
    const scope = await host.open(root);
    const first = scope.ui.bind(owner("one"), () => {});
    const second = scope.ui.bind(owner("two"), () => {});
    await until(() => seen.length === 2);
    expect(
      first.items.find((item) => item.descriptor.id === "state")?.snapshot
        .count,
    ).toBe(1);
    expect(
      second.items.find((item) => item.descriptor.id === "state")?.snapshot
        .count,
    ).toBe(2);
    revision = 1;
    notify();
    await Bun.sleep(150);
    expect(
      second.items.find((item) => item.descriptor.id === "state")?.snapshot
        .revision,
    ).toBe(2);
    fail = true;
    notify();
    await until(
      () =>
        second.items.find((item) => item.descriptor.id === "state")?.snapshot
          .state === "unavailable",
    );
    expect(JSON.stringify(second.items)).not.toContain("hidden");
    first.dispose();
    release?.({ revision: 99, state: "ready" });
    await Bun.sleep(20);
    expect(first.items).toHaveLength(0);
    expect(
      second.items.find((item) => item.descriptor.id === "state")?.snapshot
        .state,
    ).toBe("unavailable");
    second.dispose();
  } finally {
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
test("sanitized DTO limits and twenty bind/dispose cycles keep data and subscriptions bounded", async () => {
  const redactor = new SecretRedactor();
  redactor.add("known-secret");
  const snapshot = sanitizeUi(
    UiSnapshotSchema,
    {
      revision: 1,
      state: "ready",
      label: "known-secret\x1b]52;c;clipboard\x07",
      detail: "token=hidden",
    },
    redactor,
  );
  expect(JSON.stringify(snapshot)).not.toContain("known-secret");
  expect(JSON.stringify(snapshot)).not.toContain("clipboard");
  expect(snapshot.detail).not.toContain("hidden");
  expect(() =>
    sanitizeUi(UiSnapshotSchema, {
      revision: 0,
      state: "ready",
      detail: "x".repeat(65536),
    }),
  ).toThrow();
  const root = await mkdtemp(join(tmpdir(), "chisel-ui-cycles-"));
  const fixture = uiExtension();
  const host = new ExtensionHost([fixture.extension]);
  try {
    const scope = await host.open(root);
    for (let index = 0; index < 20; ++index) {
      const subscription = scope.ui.bind(owner(`owner-${index}`), () => {});
      await until(() =>
        subscription.items.every((item) => item.snapshot.state === "ready"),
      );
      expect(fixture.subscribers()).toBe(3);
      const page = await subscription.page("fixture.interface/report");
      expect(page.rows).toHaveLength(64);
      expect(page.nextCursor).toBe("64");
      subscription.dispose();
      expect(fixture.subscribers()).toBe(0);
    }
  } finally {
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed, oversize and timed-out providers fail independently; scope abort cancels pending cache waits", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-ui-fault-"));
  let aborted = false;
  const host = new ExtensionHost([
    {
      id: "fault",
      activate(ctx) {
        for (const id of ["bad", "large", "slow", "good"] as const)
          ctx.ui.register({
            id,
            slot: "context_section",
            scope: "workspace",
            title: id,
            source: {
              snapshot(binding) {
                if (id === "bad")
                  return {
                    revision: 1,
                    state: "ready",
                    owner: "foreign",
                  } as never;
                if (id === "large")
                  return {
                    revision: 1,
                    state: "ready",
                    detail: "x".repeat(65537),
                  };
                if (id === "slow")
                  return new Promise((resolve) => {
                    binding.signal.addEventListener(
                      "abort",
                      () => {
                        aborted = true;
                        resolve({ revision: 99, state: "ready" });
                      },
                      { once: true },
                    );
                  });
                return {
                  revision: 1,
                  state: "ready",
                  detail: "Соседний provider работает",
                };
              },
            },
          });
      },
    },
  ]);
  try {
    const scope = await host.open(root);
    const subscription = scope.ui.bind(owner("one"), () => {});
    await until(
      () =>
        subscription.items.find((item) => item.key === "fault/slow")?.snapshot
          .state === "unavailable",
    );
    expect(aborted).toBe(true);
    expect(
      subscription.items.filter(
        (item) => item.snapshot.state === "unavailable",
      ),
    ).toHaveLength(3);
    expect(
      subscription.items.find((item) => item.key === "fault/good")?.snapshot
        .detail,
    ).toBe("Соседний provider работает");
    scope.abortLifetime();
    expect(subscription.isLive()).toBe(false);
    expect(subscription.items).toHaveLength(0);
  } finally {
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
