import type { ElementHandle, Locator, Page, Request } from "playwright-core";
import { RuntimeError } from "../runtime/errors.js";

export const viewports = {
  phone: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 },
} as const;

export function safeText(value: string, limit = 600) {
  return value
    .replace(/\p{C}/gu, (char) => (char === "\n" ? "\n" : ""))
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, cleanUrl)
    .replace(
      /\b(?:Bearer\s+[^\s"',]+|(?:password|token|api[_-]?key|authorization|cookie)\s*[:=]\s*[^\s"',;]+)/gi,
      "[redacted]",
    )
    .slice(0, limit);
}

export function cleanUrl(value: string) {
  try {
    const url = new URL(value);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol))
      return url.protocol === "about:" ? "about:blank" : "[blocked scheme]";
    return (url.origin + url.pathname).slice(0, 1000);
  } catch {
    return "[invalid URL]";
  }
}

type Entry = {
  cursor: number;
  type: string;
  message?: string;
  method?: string;
  url?: string;
  status?: number;
  durationMs?: number;
};
type Target = Locator | ElementHandle;
type Ref = { id: string; label: string; element: ElementHandle };
const candidates =
  "a[href],button,input,textarea,select,[role='button'],[contenteditable='true']";
const secretControls = "input,textarea,select,[contenteditable],[data-private]";

export class BrowserPage {
  private sequence = 0;
  private documentRevision = 0;
  private readonly refs = new Map<string, Ref>();
  private readonly console: Entry[] = [];
  private readonly network: Entry[] = [];
  private readonly secrets = new Set<string>();
  private readonly requests = new WeakMap<Request, number>();
  snapshot?: {
    accessibility: string;
    refs: { id: string; label: string }[];
    overflow: number;
  };
  url = "about:blank";
  title = "";
  status = "ready";
  preview?: string;

  constructor(
    readonly id: string,
    readonly page: Page,
    changed: () => void,
  ) {
    page.setDefaultTimeout(4_000);
    page.setDefaultNavigationTimeout(8_000);
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      this.url = cleanUrl(frame.url());
      this.title = "";
      this.invalidate();
      changed();
    });
    page.on("download", (download) => {
      void download.cancel().catch(() => {});
    });
    page.on("filechooser", (chooser) => {
      void chooser.setFiles([]).catch(() => {});
    });
    page.on("crash", () => {
      this.status = "crashed";
      this.invalidate();
      changed();
    });
    page.on("console", (entry) =>
      this.push(this.console, {
        type: entry.type(),
        message: this.clean(entry.text()),
        url: entry.location().url ? cleanUrl(entry.location().url) : undefined,
      }),
    );
    page.on("pageerror", (error) =>
      this.push(this.console, {
        type: "pageerror",
        message: this.clean(error.stack ?? error.message, 1000),
      }),
    );
    page.on("request", (request) =>
      this.requests.set(request, performance.now()),
    );
    const requestEntry = (request: Request) => ({
      method: request.method(),
      url: cleanUrl(request.url()),
      durationMs: Math.round(
        performance.now() - (this.requests.get(request) ?? performance.now()),
      ),
    });
    page.on("requestfinished", (request) => {
      void request
        .response()
        .then((response) =>
          this.push(this.network, {
            ...requestEntry(request),
            type: "response",
            status: response?.status(),
          }),
        )
        .catch(() => {});
    });
    page.on("requestfailed", (request) =>
      this.push(this.network, {
        ...requestEntry(request),
        type: "failed",
        message: this.clean(request.failure()?.errorText ?? ""),
      }),
    );
    page.on("websocket", (socket) => {
      this.push(this.network, {
        type: "websocket",
        url: cleanUrl(socket.url()),
        method: "GET",
      });
      socket.on("socketerror", (error) =>
        this.push(this.network, {
          type: "failed",
          url: cleanUrl(socket.url()),
          method: "GET",
          message: this.clean(error),
        }),
      );
    });
    this.notify = changed;
  }

  private readonly notify: () => void;

  clean(value: string, limit?: number) {
    for (const secret of this.secrets)
      value = value.replaceAll(secret, "[redacted]");
    return safeText(value, limit);
  }

  remember(value: string) {
    if (value && this.secrets.size < 128) this.secrets.add(value);
  }

  private push(target: Entry[], entry: Omit<Entry, "cursor">) {
    target.push({ cursor: ++this.sequence, ...entry });
    if (target.length > 96) target.shift();
    this.notify();
  }

  logs(kind: "console" | "network", after = 0, type?: string) {
    const rows = kind === "console" ? this.console : this.network;
    const entries = rows
      .filter((row) => row.cursor > after && (!type || row.type === type))
      .slice(0, 16);
    return {
      entries,
      cursor: entries.at(-1)?.cursor ?? after,
      oldestCursor: rows[0]?.cursor,
    };
  }

  invalidate() {
    this.documentRevision++;
    this.snapshot = undefined;
    this.preview = undefined;
    for (const { element } of this.refs.values())
      void element.dispose().catch(() => {});
    this.refs.clear();
  }

  async capture() {
    const page = this.page;
    this.invalidate();
    const revision = this.documentRevision;
    const [title, accessibility, overflow] = await Promise.all([
      page.title(),
      page.locator("body").ariaSnapshot({ timeout: 3_000, depth: 5 }),
      page.evaluate(() =>
        Math.max(
          0,
          document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      ),
    ]);
    const candidatesList = page.locator(candidates);
    const elements = await Promise.all(
      Array.from(
        { length: Math.min(await candidatesList.count(), 18) },
        (_, index) =>
          candidatesList
            .nth(index)
            .elementHandle({ timeout: 800 })
            .catch(() => null),
      ),
    );
    const refs: Ref[] = [];
    for (const element of elements) {
      if (!element) continue;
      const label = await element
        .evaluate((node) =>
          (
            node.getAttribute("aria-label") ||
            node.getAttribute("placeholder") ||
            (!node.matches(
              "input,textarea,select,[contenteditable],[data-private]",
            )
              ? node.textContent?.slice(0, 180)
              : "") ||
            node.getAttribute("name") ||
            node.tagName.toLowerCase()
          )
            .trim()
            .slice(0, 120),
        )
        .catch(() => "");
      const id = crypto.randomUUID();
      refs.push({ id, label: this.clean(label, 100), element });
    }
    if (revision !== this.documentRevision) {
      for (const { element } of refs) void element.dispose().catch(() => {});
      throw new RuntimeError(
        "BROWSER_STALE",
        "Page changed during capture. Refresh the snapshot.",
      );
    }
    for (const ref of refs) {
      this.refs.set(ref.id, ref);
    }
    this.url = cleanUrl(page.url());
    this.title = this.clean(title, 160);
    this.snapshot = {
      // ARIA can include control values after a colon. Keep only the role and name.
      accessibility: this.clean(
        accessibility
          .split("\n")
          .map((line) =>
            line.replace(
              /((?:textbox|searchbox|combobox|spinbutton|slider|option)\b.*?): .*/,
              "$1",
            ),
          )
          .join("\n"),
        2400,
      ),
      refs: [...this.refs.values()].map(({ id, label }) => ({ id, label })),
      overflow,
    };
  }

  async target(input: { ref?: string; selector?: string }): Promise<Target> {
    if (input.ref) {
      const ref = this.refs.get(input.ref);
      if (
        ref &&
        (await ref.element
          .evaluate((node) => node.isConnected)
          .catch(() => false))
      )
        return ref.element;
      throw new RuntimeError(
        "BROWSER_STALE",
        "Element reference expired or belongs to another tab. Refresh the snapshot.",
      );
    }
    const locator = this.page.locator(`css=${input.selector}`);
    if ((await locator.count()) !== 1)
      throw new RuntimeError(
        "BROWSER_STALE",
        "CSS selector must match exactly one element. Refresh the snapshot.",
      );
    return locator;
  }

  async inspect(target: Target) {
    const summarize = (node: Element) => {
      const bounds = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        tag: node.tagName.toLowerCase(),
        role: node.getAttribute("role"),
        text:
          node.matches(
            "input,textarea,select,[contenteditable],[data-private]",
          ) ||
          node.querySelector(
            "input,textarea,select,[contenteditable],[data-private]",
          )
            ? ""
            : node.textContent?.slice(0, 600),
        bounds: {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        },
        outsideViewport:
          bounds.x < 0 ||
          bounds.right > innerWidth ||
          bounds.y < 0 ||
          bounds.bottom > innerHeight,
        computed: {
          display: style.display,
          position: style.position,
          overflowX: style.overflowX,
          width: style.width,
          minWidth: style.minWidth,
          maxWidth: style.maxWidth,
          color: style.color,
          backgroundColor: style.backgroundColor,
          fontSize: style.fontSize,
        },
      };
    };
    const summary =
      "count" in target
        ? await target.evaluate(summarize)
        : await target.evaluate(summarize);
    return {
      ...summary,
      role: summary.role ? this.clean(summary.role, 80) : null,
      text: this.clean(summary.text ?? ""),
    };
  }

  latestLogs(kind: "console" | "network") {
    return (kind === "console" ? this.console : this.network).slice(-3);
  }

  async screenshot(target?: Target, maskSelector?: string, fullPage = false) {
    const mask = [
      this.page.locator(secretControls),
      ...(maskSelector ? [this.page.locator(`css=${maskSelector}`)] : []),
    ];
    const options = {
      type: "png" as const,
      animations: "disabled" as const,
      mask,
      timeout: 5_000,
    };
    let clip:
      | { x: number; y: number; width: number; height: number }
      | undefined;
    if (target) {
      await target.scrollIntoViewIfNeeded();
      const bounds = await target.boundingBox();
      if (!bounds || bounds.width > 1600 || bounds.height > 1200)
        throw new RuntimeError(
          "BROWSER_LIMIT",
          "Element is hidden or exceeds 1600 × 1200 pixels. Capture the viewport instead.",
        );
      const [x, y] = await this.page.evaluate(() => [
        window.scrollX,
        window.scrollY,
      ]);
      clip = {
        x: Math.max(0, bounds.x + (x ?? 0)),
        y: Math.max(0, bounds.y + (y ?? 0)),
        width: bounds.width,
        height: bounds.height,
      };
    } else if (fullPage) {
      const tooLarge = await this.page.evaluate(
        () =>
          document.documentElement.scrollWidth > 1600 ||
          document.documentElement.scrollHeight > 1200,
      );
      if (tooLarge)
        throw new RuntimeError(
          "BROWSER_LIMIT",
          "Full page exceeds 1600 × 1200 pixels. Capture the viewport instead.",
        );
      clip = { x: 0, y: 0, width: 1600, height: 1200 };
    }
    const png = await this.page.screenshot({
      ...options,
      fullPage: fullPage || !!target,
      clip,
    });
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    if (width > 1600 || height > 1200)
      throw new RuntimeError(
        "BROWSER_LIMIT",
        "Screenshot exceeds 1600 × 1200 pixels.",
      );
    if (png.length > 2 * 1024 * 1024)
      throw new RuntimeError("BROWSER_LIMIT", "Screenshot exceeds 2 MiB.");
    if (width * height <= 1_048_576 && png.length <= 28_000)
      this.preview = png.toString("base64");
    else this.preview = undefined;
    return { png, width, height };
  }
}
