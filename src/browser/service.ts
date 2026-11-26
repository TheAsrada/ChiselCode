import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, BrowserContext, Page, Response } from "playwright-core";
import { abortable } from "../extensions/lifecycle.js";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import type { ConversationToolOwner } from "../tools/types.js";
import { localUrl, readBrowserPolicy, requireOrigin } from "./config.js";
import { startEgress } from "./egress.js";
import {
  browserInstallState,
  installBrowser,
  loadChromium,
} from "./install.js";
import { chromiumLauncher, proxyUrl } from "./launcher.js";
import { BrowserPage, cleanUrl, viewports } from "./page.js";

export type BrowserAction = {
  tab?: string;
  origin?: string;
  url?: string;
  modelImage?: boolean;
  fullPage?: boolean;
  action?: "back" | "reload" | "close" | "select" | "refresh" | "viewport";
  preset?: keyof typeof viewports;
  width?: number;
  height?: number;
  ref?: string;
  selector?: string;
  operation?: "click" | "fill" | "select" | "press" | "scroll";
  value?: string;
  mask?: string;
};
type Engine = {
  browser: Browser;
  context: BrowserContext;
  proxy: Awaited<ReturnType<typeof startEgress>>;
  work: string;
  origin: string;
  monitor: ReturnType<typeof setInterval>;
};
type Artifact = { path: string; expiry: ReturnType<typeof setTimeout> };

type Owner = {
  signal: AbortSignal;
  disposeListener: () => void;
  tabs: Map<string, BrowserPage>;
  selected?: string;
  engine?: Engine;
  starting?: Promise<Engine>;
  closingEngine?: Promise<void>;
  queue: Promise<unknown>;
  pending: number;
  visible: boolean;
  draft?: string;
  section?: "page" | "console" | "network";
  busy: boolean;
  error?: string;
  recovery: boolean;
  closing?: Promise<void>;
  artifacts: Set<Artifact>;
};

function checkNavigation(response: Response | null) {
  if (response && response.status() >= 400)
    throw new RuntimeError(
      "BROWSER_NAVIGATION_FAILED",
      `Navigation returned HTTP ${response.status()}.`,
    );
}

async function deadline<T>(task: Promise<T>, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new RuntimeError("BROWSER_RECOVERY_REQUIRED", message)),
          9_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** One service per canonical workspace activation. Only host-owned conversation
 * signals can keep a browser alive across invocations. */
export class BrowserService {
  private readonly owners = new Map<string, Owner>();
  private readonly listeners = new Set<() => void>();
  private readonly installations = new Set<Promise<unknown>>();
  private revision = 0;
  private disposed = false;
  constructor(
    private readonly root: string,
    private readonly configPath?: string,
  ) {}

  private changed() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  subscribe(changed: () => void) {
    this.listeners.add(changed);
    return {
      dispose: () => {
        this.listeners.delete(changed);
      },
    };
  }

  private async policy(origin?: string) {
    if (this.disposed)
      throw new RuntimeError(
        "BROWSER_ACCESS_DENIED",
        "Browser extension is disabled.",
      );
    const current = await readBrowserPolicy(this.root, this.configPath);
    if (this.disposed)
      throw new RuntimeError(
        "BROWSER_ACCESS_DENIED",
        "Browser extension is disabled.",
      );
    requireOrigin(current, origin);
    return current;
  }

  private owner(identity: ConversationToolOwner) {
    cancelled(identity.signal);
    const found = this.owners.get(identity.id);
    if (found) {
      if (found.signal !== identity.signal || found.closing)
        throw new RuntimeError(
          "BROWSER_RECOVERY_REQUIRED",
          "Previous browser owner is still closing.",
        );
      return found;
    }
    if (this.owners.size >= 24)
      throw new RuntimeError(
        "BROWSER_LIMIT",
        "Too many browser conversation owners.",
      );
    const onAbort = () => {
      void this.closeOwner(identity.id).catch(() => {});
    };
    const owner: Owner = {
      signal: identity.signal,
      disposeListener: () =>
        identity.signal.removeEventListener("abort", onAbort),
      tabs: new Map(),
      queue: Promise.resolve(),
      pending: 0,
      visible: false,
      busy: false,
      recovery: false,
      artifacts: new Set(),
    };
    identity.signal.addEventListener("abort", onAbort, { once: true });
    this.owners.set(identity.id, owner);
    return owner;
  }

  presentation(id?: string) {
    const owner = id ? this.owners.get(id) : undefined;
    return { draft: owner?.draft, section: owner?.section ?? "page" };
  }

  setPresentation(
    id: string | undefined,
    update: { draft?: string; section?: Owner["section"] },
  ) {
    const owner = id ? this.owners.get(id) : undefined;
    if (!owner || owner.closing) return;
    Object.assign(owner, update);
    this.changed();
  }

  async toggle(identity: ConversationToolOwner) {
    await this.policy();
    const owner = this.owner(identity);
    owner.visible = !owner.visible;
    this.changed();
    return owner.visible;
  }

  async install(signal?: AbortSignal) {
    await this.policy();
    const work = installBrowser(signal);
    this.installations.add(work);
    try {
      await work;
      return { state: "ready" };
    } finally {
      this.installations.delete(work);
      this.changed();
    }
  }

  private tab(owner: Owner | undefined, id?: string) {
    const key = id ?? owner?.selected;
    const tab = key ? owner?.tabs.get(key) : undefined;
    if (!tab)
      throw new RuntimeError(
        "BROWSER_STALE",
        "Choose an open tab from browser status.",
      );
    if (tab.status === "crashed")
      throw new RuntimeError(
        "BROWSER_CRASHED",
        "The page crashed. Close its tab and open a new one.",
      );
    return tab;
  }

  async prepare(id: string, input: BrowserAction) {
    const owner = this.owners.get(id);
    const url = input.url ? localUrl(input.url) : undefined;
    const origin = url?.origin ?? owner?.engine?.origin;
    await this.policy(origin);
    if (owner?.recovery)
      throw new RuntimeError(
        "BROWSER_RECOVERY_REQUIRED",
        "Browser cleanup is unconfirmed.",
      );
    if (url && origin !== owner?.engine?.origin && owner?.engine)
      throw new RuntimeError(
        "BROWSER_ACCESS_DENIED",
        "Close the existing browser tabs before changing origin.",
      );
    const tab = url
      ? undefined
      : input.action === "close"
        ? (input.tab ?? owner?.selected)
        : this.tab(owner, input.tab).id;
    if (!url && !tab)
      throw new RuntimeError("BROWSER_STALE", "No open browser tab.");
    return { ...input, origin, url: url?.href, tab };
  }

  async view(id?: string, tabId?: string) {
    const owner = id ? this.owners.get(id) : undefined;
    const policy = await this.policy();
    const origin = owner?.engine?.origin;
    const accessible = !origin || policy.origins.includes(origin);
    const selected = accessible
      ? owner?.tabs.get(tabId ?? owner.selected ?? "")
      : undefined;
    if (tabId && !selected)
      throw new RuntimeError(
        "BROWSER_STALE",
        "Choose an open tab from browser status.",
      );
    return {
      revision: this.revision,
      visible: owner?.visible ?? false,
      busy: owner?.busy ?? false,
      error: owner?.error,
      runtime: owner?.recovery
        ? "recovery_required"
        : await browserInstallState(),
      tabs: accessible
        ? [...(owner?.tabs.values() ?? [])].map((tab) => this.describe(tab))
        : [],
      selected: selected?.id,
      page: selected ? this.describe(selected) : undefined,
      snapshot: selected?.snapshot,
      preview: selected?.preview,
      console: selected?.latestLogs("console") ?? [],
      network: selected?.latestLogs("network") ?? [],
    };
  }

  async diagnostics(
    id: string,
    kind: "console" | "network",
    tabId?: string,
    after?: number,
    type?: string,
  ) {
    const owner = this.owners.get(id);
    await this.policy(owner?.engine?.origin);
    return this.tab(owner, tabId).logs(kind, after, type);
  }

  private describe(tab: BrowserPage) {
    return {
      id: tab.id,
      url: tab.url,
      title: tab.title,
      status: tab.status,
      viewport: tab.page.viewportSize(),
    };
  }

  private async start(owner: Owner, origin: string) {
    if (owner.closingEngine) await owner.closingEngine;
    cancelled(owner.signal);
    await this.policy(origin);
    cancelled(owner.signal);
    if (owner.recovery)
      throw new RuntimeError(
        "BROWSER_RECOVERY_REQUIRED",
        "Previous browser cleanup is unconfirmed.",
      );
    if (owner.engine) {
      if (owner.engine.origin !== origin)
        throw new RuntimeError(
          "BROWSER_ACCESS_DENIED",
          "Close existing tabs before changing origin.",
        );
      return owner.engine;
    }
    if (
      [...this.owners.values()].filter(
        (item) => item.starting || item.engine || item.closingEngine,
      ).length >= 3
    )
      throw new RuntimeError(
        "BROWSER_LIMIT",
        "This workspace already has three active browser owners.",
      );
    const start = this.launch(owner, origin);
    owner.starting = start;
    try {
      return await start;
    } finally {
      if (owner.starting === start) owner.starting = undefined;
    }
  }

  private async launch(owner: Owner, origin: string): Promise<Engine> {
    const { chromium, executableDir } = await loadChromium();
    const work = await mkdtemp("/tmp/chisel-browser-");
    let proxy: Engine["proxy"] | undefined;
    let browser: Browser | undefined;
    try {
      const socket = join(work, "egress.sock");
      const launcher = join(work, "chromium");
      await writeFile(launcher, chromiumLauncher, { mode: 0o700, flag: "wx" });
      const allowed = () =>
        this.policy(origin).then(
          () => !owner.closing,
          () => false,
        );
      proxy = await startEgress(socket, origin, allowed);
      await chmod(socket, 0o600);
      cancelled(owner.signal);
      browser = await chromium.launch({
        executablePath: launcher,
        headless: true,
        chromiumSandbox: true,
        timeout: 10_000,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        env: {
          CHISEL_BROWSER_CHROMIUM: executableDir,
          CHISEL_BROWSER_SOCKET: socket,
          PATH: "/usr/bin:/bin",
          HOME: work,
        },
        args: [
          `--proxy-server=${proxyUrl}`,
          "--proxy-bypass-list=<-loopback>",
          "--disable-quic",
          "--disable-external-intent-requests",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          "--disable-dev-shm-usage",
          "--disable-extensions",
        ],
      });
      cancelled(owner.signal);
      const context = await browser.newContext({
        viewport: viewports.desktop,
        acceptDownloads: false,
        serviceWorkers: "block",
        permissions: [],
      });
      // Popup targets remain subject to the same proxy even before this event.
      context.on("page", (page) => {
        if (context.pages().length > 4) void page.close().catch(() => {});
        else
          void page
            .opener()
            .then((opener) => (opener ? page.close() : undefined))
            .catch(() => {});
      });
      const monitor = setInterval(() => {
        void allowed().then((ok) => {
          if (!ok && owner.engine?.monitor === monitor)
            void this.stopEngine(owner, "Доступ к адресу отозван.").catch(
              () => {},
            );
        });
      }, 750);
      monitor.unref();
      const engine = { browser, context, proxy, work, origin, monitor };
      owner.engine = engine;
      browser.on("disconnected", () => {
        if (owner.engine === engine)
          void this.stopEngine(owner, "Chromium завершился аварийно.").catch(
            () => {},
          );
      });
      return engine;
    } catch (error) {
      const attempts = await Promise.allSettled([
        browser &&
          deadline(browser.close(), "Chromium exit was not confirmed."),
        proxy?.close(),
      ]);
      await rm(work, { recursive: true, force: true });
      if (attempts.some((attempt) => attempt.status === "rejected")) {
        owner.recovery = true;
        throw new RuntimeError(
          "BROWSER_RECOVERY_REQUIRED",
          "Failed to confirm browser cleanup.",
        );
      }
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError(
        "BROWSER_UNAVAILABLE",
        "Chromium could not start. Check bubblewrap, user namespaces, Python 3 and Chromium system libraries.",
      );
    }
  }

  private stopEngine(owner: Owner, error?: string) {
    if (owner.closingEngine) return owner.closingEngine;
    const engine = owner.engine;
    if (!engine) return Promise.resolve();
    owner.engine = undefined;
    clearInterval(engine.monitor);
    for (const tab of owner.tabs.values()) tab.invalidate();
    owner.tabs.clear();
    owner.selected = undefined;
    owner.error = error;
    const stop = (async () => {
      const cleanup = await Promise.allSettled([
        deadline(engine.browser.close(), "Chromium exit was not confirmed."),
        deadline(engine.proxy.close(), "Proxy exit was not confirmed."),
      ]);
      await rm(engine.work, { recursive: true, force: true });
      if (cleanup.some((result) => result.status === "rejected"))
        throw new RuntimeError(
          "BROWSER_RECOVERY_REQUIRED",
          "Failed to confirm browser cleanup.",
        );
    })();
    owner.closingEngine = stop
      .catch((cause) => {
        owner.recovery = true;
        throw cause;
      })
      .finally(() => {
        owner.closingEngine = undefined;
        this.changed();
      });
    this.changed();
    return owner.closingEngine;
  }

  private async closePage(owner: Owner, tab: BrowserPage) {
    tab.invalidate();
    owner.tabs.delete(tab.id);
    if (owner.selected === tab.id)
      owner.selected = [...owner.tabs.keys()].at(-1);
    try {
      await deadline(tab.page.close(), "Tab closure was not confirmed.");
    } catch (error) {
      await this.stopEngine(owner);
      throw error;
    }
    if (!owner.tabs.size) await this.stopEngine(owner);
  }

  private closeOwner(id: string) {
    const owner = this.owners.get(id);
    if (!owner) return Promise.resolve();
    owner.closing ??= Promise.resolve().then(async () => {
      owner.disposeListener();
      await owner.starting?.catch(() => {});
      const [engine] = await Promise.allSettled([this.stopEngine(owner)]);
      await owner.queue;
      const artifacts = await Promise.allSettled(
        [...owner.artifacts].map((artifact) => {
          clearTimeout(artifact.expiry);
          return rm(artifact.path, { recursive: true, force: true });
        }),
      );
      if (
        owner.recovery ||
        engine.status === "rejected" ||
        artifacts.some((result) => result.status === "rejected")
      ) {
        owner.recovery = true;
        throw new RuntimeError(
          "BROWSER_RECOVERY_REQUIRED",
          "Previous browser cleanup is unconfirmed.",
        );
      }
      this.owners.delete(id);
      this.changed();
    });
    return owner.closing;
  }

  async dispose() {
    this.disposed = true;
    const results = await Promise.allSettled([
      ...[...this.owners.keys()].map((id) => this.closeOwner(id)),
      ...[...this.installations].map((work) => work.catch(() => {})),
    ]);
    this.listeners.clear();
    if (results.some((result) => result.status === "rejected"))
      throw new RuntimeError(
        "BROWSER_RECOVERY_REQUIRED",
        "Browser cleanup was not confirmed.",
      );
  }

  private async saveScreenshot(
    owner: Owner,
    capture: Awaited<ReturnType<BrowserPage["screenshot"]>>,
  ) {
    if (owner.artifacts.size >= 8)
      throw new RuntimeError(
        "BROWSER_LIMIT",
        "Eight captures are retained for this conversation; retry after they expire.",
      );
    const dir = await mkdtemp("/tmp/chisel-capture-");
    const path = join(dir, "capture.png");
    const remove = async () => rm(dir, { recursive: true, force: true });
    try {
      await writeFile(path, capture.png, { mode: 0o600, flag: "wx" });
    } catch (error) {
      await remove();
      throw error;
    }
    const artifact: Artifact = {
      path: dir,
      expiry: setTimeout(() => {
        void remove()
          .then(() => owner.artifacts.delete(artifact))
          .catch(() => {});
      }, 15 * 60_000),
    };
    artifact.expiry.unref();
    owner.artifacts.add(artifact);
    return {
      uri: pathToFileURL(path).href,
      width: capture.width,
      height: capture.height,
      modelImage: "unavailable",
    };
  }

  run(
    identity: ConversationToolOwner,
    input: BrowserAction,
    kind: "open" | "navigate" | "interact" | "inspect" | "screenshot",
    signal?: AbortSignal,
    offerImage?: (origin: string, png: Uint8Array) => Promise<boolean>,
  ) {
    const owner = this.owner(identity);
    if (owner.pending >= 6)
      throw new RuntimeError(
        "BROWSER_LIMIT",
        "Too many queued browser actions.",
      );
    owner.pending++;
    const operation = owner.queue.then(async () => {
      cancelled(signal);
      cancelled(owner.signal);
      if (owner.closing || owner.recovery)
        throw new RuntimeError(
          "BROWSER_RECOVERY_REQUIRED",
          "Browser owner is closing.",
        );
      await this.policy(input.origin);
      const actionSignal = signal
        ? AbortSignal.any([signal, owner.signal])
        : owner.signal;
      owner.busy = true;
      owner.error = undefined;
      this.changed();
      let tab: BrowserPage | undefined;
      let launch: Promise<Engine> | undefined;
      let openingPage: Promise<Page> | undefined;
      try {
        if (kind === "open") {
          if (!input.origin || !input.url)
            throw new Error("Browser target is missing.");
          if (owner.tabs.size >= 4)
            throw new RuntimeError(
              "BROWSER_LIMIT",
              "Close one of the four open tabs.",
            );
          launch = this.start(owner, input.origin);
          const engine = await abortable(
            () => launch as Promise<Engine>,
            actionSignal,
          );
          openingPage = engine.context.newPage();
          const page = await abortable(
            () => openingPage as Promise<Page>,
            actionSignal,
          );
          tab = new BrowserPage(crypto.randomUUID(), page, () =>
            this.changed(),
          );
          owner.tabs.set(tab.id, tab);
          owner.selected = tab.id;
          const opened = tab;
          page.once("close", () => {
            if (owner.tabs.get(opened.id) !== opened) return;
            owner.tabs.delete(opened.id);
            if (owner.selected === opened.id)
              owner.selected = [...owner.tabs.keys()].at(-1);
            if (!owner.tabs.size) void this.stopEngine(owner).catch(() => {});
            this.changed();
          });
          try {
            checkNavigation(
              await abortable(
                () =>
                  page.goto(input.url as string, {
                    waitUntil: "domcontentloaded",
                  }),
                actionSignal,
              ),
            );
            if (localUrl(page.url()).origin !== input.origin)
              throw new RuntimeError(
                "BROWSER_ACCESS_DENIED",
                "Navigation left the approved origin.",
              );
          } catch (error) {
            tab.status = "navigation_failed";
            throw error;
          }
        } else {
          if (!input.origin || owner.engine?.origin !== input.origin)
            throw new RuntimeError(
              "BROWSER_STALE",
              "Browser generation changed after approval.",
            );
          if (input.action === "close") {
            const closing = owner.tabs.get(input.tab ?? "");
            if (!closing)
              throw new RuntimeError(
                "BROWSER_STALE",
                "Browser tab already closed.",
              );
            await this.closePage(owner, closing);
            return { closed: closing.id, selected: owner.selected };
          }
          tab = this.tab(owner, input.tab);
          const selected = tab;
          const page = tab.page;
          if (kind === "navigate") {
            owner.selected = tab.id;
            if (input.action === "select") return this.describe(tab);
            if (input.action === "back")
              checkNavigation(
                await abortable(
                  () => page.goBack({ waitUntil: "domcontentloaded" }),
                  actionSignal,
                ),
              );
            if (input.action === "reload")
              checkNavigation(
                await abortable(
                  () => page.reload({ waitUntil: "domcontentloaded" }),
                  actionSignal,
                ),
              );
            if (input.action === "viewport")
              await abortable(
                () =>
                  page.setViewportSize(
                    input.preset
                      ? viewports[input.preset]
                      : {
                          width: input.width as number,
                          height: input.height as number,
                        },
                  ),
                actionSignal,
              );
          } else {
            const target =
              input.ref || input.selector
                ? await abortable(() => selected.target(input), actionSignal)
                : undefined;
            if (kind === "screenshot") {
              const capture = await abortable(
                () => selected.screenshot(target, input.mask, input.fullPage),
                actionSignal,
              );
              const screenshot = await this.saveScreenshot(owner, capture);
              const send =
                offerImage &&
                capture.width * capture.height <= 1_048_576 &&
                (await offerImage(input.origin, capture.png));
              return {
                ...this.describe(tab),
                screenshot: {
                  ...screenshot,
                  modelImage: send ? "queued" : "unavailable",
                },
                overflow: tab.snapshot?.overflow,
              };
            }
            if (!target)
              throw new RuntimeError(
                "INVALID_TOOL_INPUT",
                "Specify one element reference or CSS selector.",
              );
            if (kind === "inspect")
              return await abortable(
                () => selected.inspect(target),
                actionSignal,
              );
            await abortable(async () => {
              switch (input.operation) {
                case "click":
                  return target.click();
                case "fill":
                  selected.remember(input.value ?? "");
                  return target.fill(input.value ?? "");
                case "select":
                  return target.selectOption(input.value ?? "");
                case "press":
                  return target.press(input.value ?? "");
                case "scroll":
                  return target.scrollIntoViewIfNeeded();
              }
            }, actionSignal);
          }
        }
        const current = tab;
        await abortable(() => current.capture(), actionSignal);
        tab.status = "ready";
        return { ...this.describe(tab), snapshot: tab.snapshot };
      } catch (error) {
        if (actionSignal.aborted) {
          if (tab && owner.tabs.has(tab.id)) await this.closePage(owner, tab);
          else if (openingPage)
            await openingPage
              .then((page) =>
                deadline(page.close(), "Tab closure was not confirmed."),
              )
              .catch(() => this.stopEngine(owner));
          await launch?.catch(() => {});
          if (!owner.tabs.size) await this.stopEngine(owner);
          throw new RuntimeError("CANCELLED", "Browser action cancelled.");
        }
        if (kind === "open" && !owner.tabs.size) await this.stopEngine(owner);
        if (tab?.status === "crashed" || (input.origin && !owner.engine && tab))
          throw new RuntimeError(
            "BROWSER_CRASHED",
            "Chromium or the page closed during the action.",
          );
        if (error instanceof RuntimeError) {
          owner.error = error.message;
          throw error;
        }
        if (error instanceof Error && error.name === "TimeoutError") {
          if (tab && owner.tabs.has(tab.id)) await this.closePage(owner, tab);
          owner.error = "Время ожидания браузера истекло.";
          throw new RuntimeError("TOOL_TIMEOUT", owner.error);
        }
        const url = tab ? cleanUrl(tab.page.url()) : "";
        owner.error = "Действие браузера завершилось ошибкой.";
        if (
          tab &&
          (kind === "open" ||
            input.action === "back" ||
            input.action === "reload")
        )
          tab.status = "navigation_failed";
        throw new RuntimeError(
          kind === "open" ||
            input.action === "back" ||
            input.action === "reload"
            ? "BROWSER_NAVIGATION_FAILED"
            : "TOOL_EXECUTION_FAILURE",
          `${owner.error} ${url}`.trim(),
        );
      } finally {
        owner.busy = false;
        this.changed();
      }
    });
    owner.queue = operation
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        owner.pending--;
      });
    return operation;
  }
}
