import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { RuntimeError } from "../runtime/errors.js";
import type { WebResponse } from "./http-client.js";

export interface WebDocument {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  fetchedAt: string;
  contentType: string;
  text: string;
  truncated: boolean;
  redirects: string[];
}
export function textLimit(value: string, count: number): string {
  const text = value.slice(0, count);
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
}
export function referenceText(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Public documents must not contain terminal control bytes.
  const controls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
  return text.replace(/\r\n?/g, "\n").replace(controls, "");
}
export function extractDocument(
  response: WebResponse,
  maxChars: number,
): WebDocument {
  const type = response.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const supported =
    [
      "text/html",
      "application/xhtml+xml",
      "text/plain",
      "text/markdown",
      "text/x-markdown",
      "application/json",
    ].includes(type) || /^application\/[a-z0-9.+-]+\+json$/.test(type);
  if (!supported)
    throw new RuntimeError(
      "WEB_UNSUPPORTED_CONTENT",
      "Only HTML, plain text, Markdown and JSON documents are supported; binary content was not extracted.",
    );
  const charset =
    /charset\s*=\s*["']?([^\s;"']+)/i.exec(response.contentType)?.[1] ??
    "utf-8";
  let body: string;
  try {
    body = new TextDecoder(charset, { fatal: true }).decode(response.bytes);
  } catch {
    throw new RuntimeError(
      "WEB_UNSUPPORTED_CONTENT",
      "Unsupported or invalid text encoding.",
    );
  }
  if (
    body.includes("\0") ||
    ["%PDF-", "PK\u0003\u0004", "\u007fELF"].some((magic) =>
      body.startsWith(magic),
    )
  )
    throw new RuntimeError(
      "WEB_UNSUPPORTED_CONTENT",
      "Binary data was returned with a text content type.",
    );
  let title = new URL(response.finalUrl).hostname;
  let text = referenceText(body);
  if (type === "text/html" || type === "application/xhtml+xml") {
    try {
      if ((body.match(/</g)?.length ?? 0) > 50000)
        throw new RuntimeError(
          "WEB_TOO_LARGE",
          "HTML contains too many elements.",
        );
      const { document } = parseHTML(body);
      title = textLimit(
        referenceText(
          document.querySelector("title")?.textContent ??
            document.querySelector("h1")?.textContent ??
            title,
        )
          .replace(/\s+/g, " ")
          .trim(),
        240,
      );
      const queue: Array<{ node: Node; depth: number }> = [
        { node: document, depth: 0 },
      ];
      let nodes = 0;
      while (queue.length) {
        const current = queue.pop();
        if (!current) break;
        if (++nodes > 50000 || current.depth > 128)
          throw new RuntimeError(
            "WEB_TOO_LARGE",
            "HTML tree exceeds safe complexity limits.",
          );
        for (const child of current.node.childNodes)
          queue.push({ node: child, depth: current.depth + 1 });
      }
      for (const node of document.querySelectorAll(
        "script,style,nav,footer,body>header,aside,form,button,dialog,svg,canvas,noscript,template,[hidden],[aria-hidden='true'],.cookie-banner,.cookie-consent,.advertisement,.ads,[data-ad],.sidebar,.navigation",
      ))
        node.remove();
      for (const node of document.querySelectorAll("[style]"))
        if (
          /display\s*:\s*none|visibility\s*:\s*hidden/i.test(
            node.getAttribute("style") ?? "",
          )
        )
          node.remove();
      let root: Node =
        document.querySelector("main,article,[role='main']") ?? document.body;
      if (root === document.body) {
        const article = new Readability(document as unknown as Document, {
          charThreshold: 0,
          maxElemsToParse: 50000,
        }).parse();
        if (article?.content) {
          const parsed = parseHTML(
            `<html><body>${article.content}</body></html>`,
          );
          root = parsed.document.body;
          if (article.title?.trim())
            title = textLimit(referenceText(article.title), 240);
        }
      }
      text = referenceText(markdown(root, response.finalUrl))
        .replace(/\n[ \t]+\n/g, "\n\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError(
        "WEB_UNSUPPORTED_CONTENT",
        "HTML could not be converted into a readable document.",
      );
    }
  } else if (type.includes("json")) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      throw new RuntimeError(
        "WEB_UNSUPPORTED_CONTENT",
        "Server returned malformed or excessively nested JSON.",
      );
    }
  }
  // Keep artifacts readable by line range without dumping a single huge minified line.
  let shortened = false;
  text = text
    .split("\n")
    .map((line) => {
      if (line.length <= 8192) return line;
      shortened = true;
      return `${textLimit(line, 8192)} [long line truncated]`;
    })
    .join("\n");
  const truncated = shortened || text.length > maxChars;
  text = textLimit(text, maxChars);
  if (!text.trim())
    throw new RuntimeError(
      "WEB_UNSUPPORTED_CONTENT",
      "Page has no readable text. JavaScript, login flows and browser automation are not executed.",
    );
  return {
    requestedUrl: response.requestedUrl,
    finalUrl: response.finalUrl,
    title,
    fetchedAt: new Date().toISOString(),
    contentType: type,
    text,
    truncated,
    redirects: response.redirects,
  };
}

function markdown(node: Node, base: string): string {
  if (node.nodeType === 3) return (node.textContent ?? "").replace(/\s+/g, " ");
  if (node.nodeType !== 1 && node.nodeType !== 9) return "";
  const el = node as HTMLElement;
  const tag = el.tagName?.toLowerCase() ?? "";
  if (tag === "pre") {
    const code = el.textContent ?? "";
    let fenceLength = 3;
    for (const match of code.matchAll(/`+/g))
      fenceLength = Math.max(fenceLength, match[0].length + 1);
    const fence = "`".repeat(fenceLength);
    const language =
      /(?:language|lang)-([a-zA-Z0-9_+-]+)/.exec(
        el.querySelector("code")?.getAttribute("class") ?? "",
      )?.[1] ?? "";
    return `\n\n${fence}${language}\n${code.replace(/\n$/, "")}\n${fence}\n\n`;
  }
  if (tag === "table") {
    const rows = [...el.querySelectorAll("tr")]
      .slice(0, 100)
      .map((row) =>
        [...row.children]
          .slice(0, 12)
          .map((cell) =>
            textLimit(
              markdown(cell, base)
                .replace(/\s+/g, " ")
                .replace(/\|/g, "\\|")
                .trim(),
              400,
            ),
          ),
      );
    if (!rows.length) return "";
    return `\n\n${rows.map((row, i) => `| ${row.join(" | ")} |${i === 0 ? `\n| ${row.map(() => "---").join(" | ")} |` : ""}`).join("\n")}\n\n`;
  }
  const inner = [...node.childNodes]
    .map((child) => markdown(child, base))
    .join("");
  if (/^h[1-6]$/.test(tag))
    return `\n\n${"#".repeat(Number(tag[1]))} ${inner.trim()}\n\n`;
  if (tag === "br") return "\n";
  if (tag === "li") {
    const prefix =
      el.parentElement?.tagName.toLowerCase() === "ol"
        ? `${[...el.parentElement.children].indexOf(el) + 1}.`
        : "-";
    return `\n${prefix} ${inner.trim().replace(/\n/g, "\n  ")}`;
  }
  if (tag === "code") {
    const fence = inner.includes("`") ? "``" : "`";
    return `${fence}${inner}${fence}`;
  }
  if (tag === "strong" || tag === "b") return `**${inner}**`;
  if (tag === "a") {
    try {
      const href = new URL(el.getAttribute("href") ?? "", base);
      if (
        ["http:", "https:"].includes(href.protocol) &&
        !href.username &&
        !href.password &&
        inner.trim()
      )
        return `[${inner.trim()}](${href.toString()})`;
    } catch {}
    return inner;
  }
  if (
    [
      "p",
      "div",
      "section",
      "article",
      "main",
      "blockquote",
      "ul",
      "ol",
      "dl",
    ].includes(tag)
  )
    return `\n\n${inner.trim()}\n\n`;
  return inner;
}
