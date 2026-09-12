import { Box, Text } from "ink";
import type React from "react";

export interface InlineSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: string;
}

const INLINE_PATTERN =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s](?:[^*\n]*[^*\s])?\*)|(~~[^~\n]+~~)|(\[([^\]\n]+)\]\(([^)\s]+)\))/g;
const HAS_WORD = /[\p{L}\p{N}]/u;

/** Разбирает inline-разметку. Незакрытые маркеры остаются буквальным текстом. */
export function parseInline(input: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  const push = (text: string, style: Partial<InlineSegment> = {}): void => {
    if (!text) return;
    const styled = Object.keys(style).length > 0;
    const lastSegment = segments.at(-1);
    if (!styled && lastSegment && Object.keys(lastSegment).length === 1)
      lastSegment.text += text;
    else segments.push({ text, ...style });
  };
  // Стиль применяется, только если внутри есть буквы/цифры —
  // иначе маски файлов (*.*) и арифметика (2 * 3) остались бы текстом.
  const pushStyled = (
    inner: string,
    literal: string,
    style: Partial<InlineSegment>,
  ): void => {
    if (HAS_WORD.test(inner)) push(inner, style);
    else push(literal);
  };
  INLINE_PATTERN.lastIndex = 0;
  let last = 0;
  for (;;) {
    const match = INLINE_PATTERN.exec(input);
    if (match === null) break;
    push(input.slice(last, match.index));
    const [full, code, bold, italic, strike, link, linkText, linkUrl] = match;
    if (code !== undefined) push(code.slice(1, -1), { code: true });
    else if (bold !== undefined)
      pushStyled(bold.slice(2, -2), bold, { bold: true });
    else if (italic !== undefined)
      pushStyled(italic.slice(1, -1), italic, { italic: true });
    else if (strike !== undefined)
      pushStyled(strike.slice(2, -2), strike, { strike: true });
    else if (
      link !== undefined &&
      linkText !== undefined &&
      linkUrl !== undefined
    )
      push(linkText, { link: linkUrl });
    else push(full);
    last = match.index + full.length;
  }
  push(input.slice(last));
  if (segments.length === 0) segments.push({ text: input });
  return segments;
}

export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; language: string; code: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "hr" };

const HEADING_PATTERN = /^(#{1,4})\s+(.*)$/;
const LIST_PATTERN = /^\s*(?:(\d+)[.)]|[-*•])\s+(.*)$/;
const QUOTE_PATTERN = /^\s*>\s?(.*)$/;
const HR_PATTERN = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * Блочный разбор. Одиночные переносы строк внутри абзаца сохраняются —
 * это важно для служебных текстов (статус, помощь), где каждая строка
 * осмысленна сама по себе.
 */
export function parseBlocks(input: string): Block[] {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    if (line.trimStart().startsWith("```")) {
      const language = line.trimStart().slice(3).trim();
      const code: string[] = [];
      i += 1;
      while (
        i < lines.length &&
        !(lines[i] ?? "").trimStart().startsWith("```")
      ) {
        code.push(lines[i] ?? "");
        i += 1;
      }
      i += 1; // пропустить закрывающий fence (или конец текста)
      blocks.push({ kind: "code", language, code: code.join("\n") });
      continue;
    }
    const heading = HEADING_PATTERN.exec(line);
    if (heading?.[1] && heading[2] !== undefined) {
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        text: heading[2].trim(),
      });
      i += 1;
      continue;
    }
    if (HR_PATTERN.test(line)) {
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }
    const quote = QUOTE_PATTERN.exec(line);
    if (quote?.[1] !== undefined) {
      const quoted: string[] = [quote[1]];
      i += 1;
      while (i < lines.length) {
        const next = QUOTE_PATTERN.exec(lines[i] ?? "");
        if (next?.[1] === undefined) break;
        quoted.push(next[1]);
        i += 1;
      }
      blocks.push({ kind: "quote", text: quoted.join("\n") });
      continue;
    }
    const list = LIST_PATTERN.exec(line);
    if (list?.[2] !== undefined) {
      const ordered = list[1] !== undefined;
      const items: string[] = [list[2]];
      i += 1;
      while (i < lines.length) {
        const next = LIST_PATTERN.exec(lines[i] ?? "");
        if (next?.[2] === undefined) break;
        items.push(next[2]);
        i += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const paragraph: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (
        next.trim() === "" ||
        next.trimStart().startsWith("```") ||
        HEADING_PATTERN.test(next) ||
        HR_PATTERN.test(next) ||
        QUOTE_PATTERN.test(next) ||
        LIST_PATTERN.test(next)
      )
        break;
      paragraph.push(next);
      i += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
  }
  return blocks;
}

function renderInline(
  segments: InlineSegment[],
  keyPrefix: string,
): React.ReactNode[] {
  return segments.map((segment, index) => {
    const key = `${keyPrefix}-${index}`;
    if (segment.code)
      return (
        <Text key={key} color="cyan">
          {segment.text}
        </Text>
      );
    if (segment.link)
      return (
        <Text key={key}>
          <Text color="blue" underline>
            {segment.text}
          </Text>
          <Text dimColor> ({segment.link})</Text>
        </Text>
      );
    return (
      <Text
        key={key}
        bold={segment.bold}
        italic={segment.italic}
        strikethrough={segment.strike}
      >
        {segment.text}
      </Text>
    );
  });
}

/** Ответ помощника с лёгким markdown-оформлением. */
export function MarkdownText({ text }: { text: string }): React.JSX.Element {
  const blocks = parseBlocks(text);
  return (
    <>
      {blocks.map((block, index) => {
        const key = `block-${index}`;
        if (block.kind === "heading")
          return (
            <Text key={key} bold color={block.level === 1 ? "cyan" : "white"}>
              {block.text}
            </Text>
          );
        if (block.kind === "code")
          return (
            <Box
              key={key}
              flexDirection="column"
              borderStyle="round"
              borderColor="gray"
              paddingX={1}
              marginY={1}
            >
              {block.language ? <Text dimColor>{block.language}</Text> : null}
              <Text>{block.code}</Text>
            </Box>
          );
        if (block.kind === "list")
          return (
            <Box key={key} flexDirection="column">
              {block.items.map((item, itemIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: пункты markdown статичны
                <Text key={`${key}-item-${itemIndex}`}>
                  <Text color="cyan">
                    {block.ordered ? `${itemIndex + 1}. ` : "• "}
                  </Text>
                  {renderInline(parseInline(item), `${key}-item-${itemIndex}`)}
                </Text>
              ))}
            </Box>
          );
        if (block.kind === "quote")
          return (
            <Box key={key} flexDirection="column">
              {block.text.split("\n").map((line, lineIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: строки цитаты статичны
                <Text key={`${key}-quote-${lineIndex}`} dimColor>
                  <Text color="cyan">▌ </Text>
                  {renderInline(parseInline(line), `${key}-quote-${lineIndex}`)}
                </Text>
              ))}
            </Box>
          );
        if (block.kind === "hr")
          return (
            <Text key={key} dimColor>
              ──────────
            </Text>
          );
        return (
          <Text key={key}>{renderInline(parseInline(block.text), key)}</Text>
        );
      })}
    </>
  );
}
