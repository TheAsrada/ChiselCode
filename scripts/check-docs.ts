import { readdir, readFile, realpath, stat } from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export interface DocumentationLink {
  target: string;
  line: number;
}
export interface DocumentationIssue {
  file: string;
  line: number;
  message: string;
}

const blank = (text: string) => text.replace(/[^\n]/g, " ");
const unescapeMarkdown = (text: string) =>
  text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~ ])/g, "$1");
const decodeHtml = (text: string) =>
  text.replace(
    /&(?:amp|quot|apos|lt|gt|#(\d+)|#x([\da-f]+));/gi,
    (entity, decimal, hex) => {
      if (decimal || hex) {
        const value = Number.parseInt(decimal ?? hex, decimal ? 10 : 16);
        return value > 0 && value <= 0x10ffff
          ? String.fromCodePoint(value)
          : entity;
      }
      return (
        (
          {
            "&amp;": "&",
            "&quot;": '"',
            "&apos;": "'",
            "&lt;": "<",
            "&gt;": ">",
          } as Record<string, string>
        )[entity.toLowerCase()] ?? entity
      );
    },
  );

/** Keep offsets/line numbers while excluding examples and HTML comments. */
function prose(text: string): string {
  let fence: { character: string; length: number } | undefined;
  return text
    .split("\n")
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (
          marker?.[1]?.[0] === fence.character &&
          marker[1].length >= fence.length &&
          !marker[2]?.trim()
        )
          fence = undefined;
        return blank(line);
      }
      if (marker?.[1]) {
        fence = { character: marker[1].charAt(0), length: marker[1].length };
        return blank(line);
      }
      return line;
    })
    .join("\n")
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, blank);
}

function withoutInlineCode(text: string): string {
  return text.replace(/(`+)([\s\S]*?)\1(?!`)/g, blank);
}

function destination(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");
    return end < 0 ? undefined : unescapeMarkdown(trimmed.slice(1, end));
  }
  const value = /^(?:\\.|[^\s])*/.exec(trimmed)?.[0];
  return value === undefined ? undefined : unescapeMarkdown(value);
}

function closing(
  text: string,
  start: number,
  open: string,
  close: string,
): number {
  let depth = 1;
  let angle = false;
  let quote: string | undefined;
  for (let index = start + 1; index < text.length; index++) {
    const character = text[index];
    if (character === "\\") {
      index++;
      continue;
    }
    if (open === "(") {
      if (quote) {
        if (character === quote) quote = undefined;
        continue;
      }
      if (angle) {
        if (character === ">") angle = false;
        continue;
      }
      if (character === "<") {
        angle = true;
        continue;
      }
      if (
        (character === '"' || character === "'") &&
        /\s/.test(text[index - 1] ?? "")
      ) {
        quote = character;
        continue;
      }
    }
    if (character === open) depth++;
    if (character === close && --depth === 0) return index;
  }
  return -1;
}

const referenceId = (text: string) =>
  unescapeMarkdown(text).trim().replace(/\s+/g, " ").toLowerCase();

export function markdownPage(source: string): {
  links: DocumentationLink[];
  anchors: Set<string>;
} {
  const text = prose(source.replace(/\r\n?/g, "\n"));
  const anchors = new Set<string>();
  const usedSlugs = new Set<string>();
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const atx = /^ {0,3}#{1,6}[\t ]+(.+?)(?:[\t ]+#+[\t ]*)?$/.exec(line);
    const setext =
      index > 0 &&
      /^ {0,3}(?:=+|-+)[\t ]*$/.test(line) &&
      !!lines[index - 1]?.trim() &&
      !/^\s*[#>|*-]/.test(lines[index - 1] ?? "");
    const heading = atx?.[1] ?? (setext ? lines[index - 1] : undefined);
    if (heading) {
      const label = decodeHtml(
        heading
          .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
          .replace(/<[^>]*>/g, ""),
      )
        .replace(/`+([^`]*?)`+/g, "$1")
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/(^|[\s(])([*_])([^\n]+?)\2(?=$|[\s).,!?:;])/g, "$1$3")
        .replace(/~~(.+?)~~/g, "$1");
      const base = label
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
        .replace(/ /g, "-");
      let slug = base;
      let suffix = 0;
      while (usedSlugs.has(slug)) slug = `${base}-${++suffix}`;
      usedSlugs.add(slug);
      anchors.add(slug);
    }
  }
  const visible = withoutInlineCode(text);
  for (const match of visible.matchAll(
    /<[^>]+\b(?:id|name)\s*=\s*(["'])(.*?)\1[^>]*>/gi,
  ))
    anchors.add(decodeHtml(match[2] ?? ""));
  const references = new Map<string, string>();
  const definitions = new Set<number>();
  let offset = 0;
  for (const line of visible.split("\n")) {
    const match = /^ {0,3}\[([^\]]+)\]:\s*(.*)$/.exec(line);
    const target = match?.[2] === undefined ? undefined : destination(match[2]);
    if (match?.[1] && target !== undefined) {
      references.set(referenceId(match[1]), target);
      definitions.add(offset + line.indexOf("["));
    }
    offset += line.length + 1;
  }
  const links: DocumentationLink[] = [];
  const lineAt = (position: number) =>
    visible.slice(0, position).split("\n").length;
  for (let index = 0; index < visible.length; index++) {
    if (visible[index] === "\\") {
      index++;
      continue;
    }
    if (visible[index] !== "[" || definitions.has(index)) continue;
    const end = closing(visible, index, "[", "]");
    if (end < 0) continue;
    let target: string | undefined;
    let consumed = end;
    if (visible[end + 1] === "(") {
      const finish = closing(visible, end + 1, "(", ")");
      if (finish < 0) continue;
      target = destination(visible.slice(end + 2, finish));
      consumed = finish;
    } else if (visible[end + 1] === "[") {
      const finish = closing(visible, end + 1, "[", "]");
      if (finish < 0) continue;
      target = references.get(
        referenceId(
          visible.slice(end + 2, finish) || visible.slice(index + 1, end),
        ),
      );
      consumed = finish;
    } else target = references.get(referenceId(visible.slice(index + 1, end)));
    if (target !== undefined)
      links.push({ target: decodeHtml(target), line: lineAt(index) });
    index = consumed;
  }
  for (const tag of visible.matchAll(/<[a-z][^>]*>/gi)) {
    for (const attr of tag[0].matchAll(/\b(?:href|src)\s*=\s*(["'])(.*?)\1/gi))
      links.push({
        target: decodeHtml(attr[2] ?? ""),
        line: lineAt(tag.index ?? 0),
      });
  }
  return { links, anchors };
}

const inside = (root: string, target: string) => {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

export async function checkDocumentation(
  directory: string,
): Promise<{ pages: number; links: number; issues: DocumentationIssue[] }> {
  const root = await realpath(directory);
  const primary: string[] = [join(root, "README.md")];
  async function walk(directory: string): Promise<void> {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && entry.name.endsWith(".md")) primary.push(file);
    }
  }
  await walk(join(root, "docs"));
  const issues: DocumentationIssue[] = [];
  const cache = new Map<string, ReturnType<typeof markdownPage>>();
  const page = async (file: string) => {
    let parsed = cache.get(file);
    if (!parsed) {
      parsed = markdownPage(await readFile(file, "utf8"));
      cache.set(file, parsed);
    }
    return parsed;
  };
  const edges = new Map<string, string[]>();
  let links = 0;
  const pending = [...primary];
  while (pending.length) {
    const file = pending.shift();
    if (file === undefined) break;
    if (edges.has(file)) continue;
    const targets: string[] = [];
    edges.set(file, targets);
    const parsed = await page(file);
    for (const link of parsed.links) {
      if (/^[a-z][\w+.-]*:/i.test(link.target) || link.target.startsWith("//"))
        continue;
      links++;
      const fail = (message: string) =>
        issues.push({
          file: relative(root, file).split(sep).join("/"),
          line: link.line,
          message,
        });
      let path: string;
      let fragment: string;
      try {
        const hash = link.target.indexOf("#");
        path = decodeURIComponent(
          (hash < 0 ? link.target : link.target.slice(0, hash)).split("?")[0] ??
            "",
        );
        fragment = decodeURIComponent(
          hash < 0 ? "" : link.target.slice(hash + 1),
        );
      } catch {
        fail(`Некорректная ссылка: ${link.target}`);
        continue;
      }
      const target = path
        ? resolve(
            path.startsWith("/") ? root : dirname(file),
            path.replace(/^\/+/, ""),
          )
        : file;
      if (!inside(root, target)) {
        fail(`Ссылка выходит за репозиторий: ${link.target}`);
        continue;
      }
      let canonical: string;
      try {
        canonical = await realpath(target);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" &&
          (error as NodeJS.ErrnoException).code !== "ENOTDIR"
        )
          throw error;
        fail(`Нет файла или каталога: ${link.target}`);
        continue;
      }
      if (!inside(root, canonical)) {
        fail(`Ссылка ведёт за репозиторий через симлинк: ${link.target}`);
        continue;
      }
      if (!(await stat(canonical)).isFile() || extname(canonical) !== ".md")
        continue;
      targets.push(canonical);
      if (!edges.has(canonical)) pending.push(canonical);
      if (fragment && !(await page(canonical)).anchors.has(fragment))
        fail(`Нет якоря: ${link.target}`);
    }
  }
  const reached = new Set<string>();
  const queue = [join(root, "README.md")];
  while (queue.length) {
    const file = queue.pop();
    if (file === undefined) break;
    if (reached.has(file)) continue;
    reached.add(file);
    queue.push(...(edges.get(file) ?? []));
  }
  for (const file of primary)
    if (!reached.has(file))
      issues.push({
        file: relative(root, file).split(sep).join("/"),
        line: 1,
        message: "Нет пути от README.md по ссылкам документации",
      });
  return { pages: primary.length, links, issues };
}

if (import.meta.main) {
  const result = await checkDocumentation(process.cwd());
  for (const issue of result.issues)
    process.stderr.write(`${issue.file}:${issue.line}: ${issue.message}\n`);
  process.stdout.write(
    `Документация: ${result.pages} страниц, ${result.links} локальных ссылок, ${result.issues.length} ошибок.\n`,
  );
  process.exitCode = result.issues.length ? 1 : 0;
}
