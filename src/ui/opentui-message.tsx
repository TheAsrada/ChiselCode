/** @jsxImportSource @opentui/react */
import {
  RGBA,
  StyledText,
  TextAttributes,
  type TextChunk,
  TextTableRenderable,
} from "@opentui/core";
import { extend, useTerminalDimensions } from "@opentui/react";
import { lexer, type Token, type Tokens } from "marked";
import type React from "react";
import { useMemo } from "react";
import type { Palette } from "./appearance.js";
import { useTerminalDecoration } from "./terminal-decoration.js";
import { terminalLine, terminalSafeText } from "./terminal-text.js";

declare module "@opentui/react" {
  interface OpenTUIComponents {
    messageTable: typeof TextTableRenderable;
  }
}
extend({ messageTable: TextTableRenderable });

interface MessageBlock {
  token: Token;
  offset: number;
  gap: number;
}

/** Source offsets keep completed blocks mounted while the response grows. */
function blocks(tokens: readonly Token[]): MessageBlock[] {
  const result: MessageBlock[] = [];
  let offset = 0;
  let gap = false;
  for (const token of tokens) {
    if (token.type === "space") gap ||= /\n/.test(token.raw);
    else if (token.type !== "def" && token.type !== "checkbox") {
      result.push({ token, offset, gap: result.length && gap ? 1 : 0 });
      gap = /\n[ \t]*\n$/.test(token.raw);
    }
    offset += token.raw.length;
  }
  return result;
}

function entities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: "\u00a0",
  };
  return terminalSafeText(
    text.replace(
      /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (raw, value: string) => {
        if (!value.startsWith("#")) return named[value.toLowerCase()] ?? raw;
        const number =
          value[1]?.toLowerCase() === "x"
            ? Number.parseInt(value.slice(2), 16)
            : Number.parseInt(value.slice(1), 10);
        return number > 0 &&
          number <= 0x10ffff &&
          !(number >= 0xd800 && number <= 0xdfff)
          ? String.fromCodePoint(number)
          : "?";
      },
    ),
  );
}

type Colors = {
  [K in "text" | "muted" | "accent" | "green" | "surface"]: RGBA;
};

function positioned<T>(values: readonly T[], raw: (value: T) => string) {
  let offset = 0;
  return values.map((value) => {
    const item = { value, offset };
    offset += raw(value).length + 1;
    return item;
  });
}

function inline(
  tokens: readonly Token[],
  colors: Colors,
  attributes = 0,
  fg = colors.text,
): TextChunk[] {
  const result: TextChunk[] = [];
  const add = (text: string, color = fg, attrs = attributes, bg?: RGBA) => {
    if (text)
      result.push({ __isChunk: true, text, fg: color, attributes: attrs, bg });
  };
  for (const token of tokens) {
    const text = (token as Tokens.Text).text ?? token.raw;
    const children = (token as Tokens.Strong).tokens;
    switch (token.type) {
      case "strong":
        result.push(
          ...inline(children, colors, attributes | TextAttributes.BOLD, fg),
        );
        break;
      case "em":
        result.push(
          ...inline(children, colors, attributes | TextAttributes.ITALIC, fg),
        );
        break;
      case "del":
        result.push(
          ...inline(
            children,
            colors,
            attributes | TextAttributes.STRIKETHROUGH,
            colors.muted,
          ),
        );
        break;
      case "codespan":
        add(text, colors.green, attributes, colors.surface);
        break;
      case "link": {
        const link = token as Tokens.Link;
        result.push(
          ...inline(
            link.tokens,
            colors,
            attributes | TextAttributes.UNDERLINE,
            colors.accent,
          ),
        );
        // Keep the destination visible without executing HTML or terminal links.
        if (link.text !== link.href) add(` (${link.href})`, colors.muted);
        break;
      }
      case "image":
        add(
          `${text || "image"} (${(token as Tokens.Image).href})`,
          colors.muted,
        );
        break;
      case "br":
        add("\n");
        break;
      case "text":
        if (children) result.push(...inline(children, colors, attributes, fg));
        else add(entities(text));
        break;
      case "escape":
        add(text);
        break;
      default:
        add(token.type === "html" ? token.raw : entities(text));
    }
  }
  return result;
}

/** Render semantic blocks with native text; blank runs never create phantom rows. */
export function FormattedMessage({
  content,
  palette,
  width,
  id,
  streaming = false,
}: {
  content: string;
  palette: Palette;
  width?: number;
  id?: string;
  streaming?: boolean;
}) {
  const terminal = useTerminalDimensions();
  const available = Math.max(1, (width ?? terminal.width) - 1);
  const { borderChars } = useTerminalDecoration();
  const colors = useMemo(
    () =>
      Object.fromEntries(
        ["text", "muted", "accent", "green", "surface"].map((name) => [
          name,
          RGBA.fromHex(palette[name as keyof Colors]),
        ]),
      ) as Colors,
    [palette],
  );
  const parsed = useMemo(
    () =>
      lexer(terminalSafeText(content, 20_000), {
        gfm: true,
        breaks: true,
      }),
    [content],
  );

  const renderBlocks = (tokens: readonly Token[], depth = 0): React.ReactNode =>
    blocks(tokens).map(({ token, offset, gap }) => (
      <box
        key={`${offset}:${token.type}`}
        width="100%"
        flexShrink={0}
        flexDirection="column"
        marginTop={gap}
      >
        {renderBlock(token, depth)}
      </box>
    ));

  const renderBlock = (token: Token, depth: number): React.ReactNode => {
    if (depth > 8) return <text content={token.raw} fg={palette.text} />;
    switch (token.type) {
      case "list": {
        const list = token as Tokens.List;
        const start = Number(list.start) || 1;
        const marker = (item: Tokens.ListItem, index: number) =>
          `${list.ordered ? `${start + index}.` : "•"}${item.task ? ` [${item.checked ? "x" : " "}]` : ""}`;
        const markerWidth =
          Math.max(1, ...list.items.map((item, i) => marker(item, i).length)) +
          1;
        return (
          <box
            width="100%"
            flexDirection="column"
            flexShrink={0}
            backgroundColor={palette.surface}
            border={depth ? false : ["left"]}
            customBorderChars={borderChars}
            borderColor={palette.border}
            paddingLeft={1}
            paddingRight={1}
          >
            {positioned(list.items, (item) => item.raw).map(
              ({ value: item, offset }, index) => (
                <box
                  key={offset}
                  width="100%"
                  flexDirection="row"
                  flexShrink={0}
                >
                  <text
                    width={markerWidth}
                    flexShrink={0}
                    fg={palette.accent}
                    content={marker(item, index)}
                  />
                  <box
                    flexGrow={1}
                    minWidth={0}
                    flexShrink={1}
                    flexDirection="column"
                  >
                    {renderBlocks(item.tokens, depth + 1)}
                  </box>
                </box>
              ),
            )}
          </box>
        );
      }
      case "table": {
        const table = token as Tokens.Table;
        const columnKeys = positioned(table.header, (cell) => cell.text).map(
          (cell) => cell.offset,
        );
        const rowKeys = positioned(
          table.raw.split("\n").slice(2),
          (row) => row,
        ).map((row) => row.offset);
        const header = table.header.map((cell) =>
          inline(cell.tokens, colors, TextAttributes.BOLD, colors.accent),
        );
        const sourceRows =
          streaming && table.rows.at(-1)?.every((cell) => !cell.text.trim())
            ? table.rows.slice(0, -1)
            : table.rows;
        const rows = sourceRows.map((row) =>
          row.map((cell) => inline(cell.tokens, colors)),
        );
        return (
          <box
            width="100%"
            flexDirection="column"
            flexShrink={0}
            backgroundColor={palette.surface}
            border={["left"]}
            customBorderChars={borderChars}
            borderColor={palette.border}
          >
            {available >= table.header.length * 14 ? (
              <messageTable
                content={[header, ...rows]}
                width="100%"
                flexShrink={0}
                wrapMode="word"
                columnWidthMode="full"
                columnFitter="balanced"
                cellPaddingX={1}
                cellPaddingY={0}
                showBorders={false}
                border={false}
                outerBorder={false}
                fg={palette.text}
                backgroundColor={palette.surface}
                selectable
              />
            ) : rows.length ? (
              rows.map((row, index) => (
                <box
                  key={rowKeys[index]}
                  width="100%"
                  flexDirection="column"
                  flexShrink={0}
                  paddingLeft={1}
                  paddingRight={1}
                  marginTop={index ? 1 : 0}
                >
                  {header.map((label, column) => (
                    <text
                      key={columnKeys[column]}
                      width="100%"
                      flexShrink={0}
                      fg={palette.text}
                      content={
                        new StyledText([
                          ...label,
                          { __isChunk: true, text: ": ", fg: colors.muted },
                          ...(row[column] ?? []),
                        ])
                      }
                    />
                  ))}
                </box>
              ))
            ) : (
              <text
                content={new StyledText(header.flat())}
                fg={palette.accent}
              />
            )}
          </box>
        );
      }
      case "code": {
        const code = token as Tokens.Code;
        return (
          <box
            width="100%"
            flexDirection="column"
            flexShrink={0}
            backgroundColor={palette.surface}
            border={["left"]}
            customBorderChars={borderChars}
            borderColor={palette.border}
            paddingLeft={1}
            paddingRight={1}
          >
            {code.lang && (
              <text
                height={1}
                fg={palette.muted}
                content={terminalLine(code.lang, available)}
              />
            )}
            <text
              width="100%"
              flexShrink={0}
              fg={palette.green}
              content={code.text}
              selectable
            />
          </box>
        );
      }
      case "blockquote":
        return (
          <box
            width="100%"
            flexDirection="column"
            flexShrink={0}
            border={["left"]}
            customBorderChars={borderChars}
            borderColor={palette.accent}
            paddingLeft={1}
          >
            {renderBlocks((token as Tokens.Blockquote).tokens, depth + 1)}
          </box>
        );
      case "hr":
        return (
          <box
            width="100%"
            height={1}
            border={["top"]}
            customBorderChars={borderChars}
            borderColor={palette.border}
          />
        );
      default: {
        const text = token as Tokens.Paragraph;
        const heading = token.type === "heading";
        return (
          <text
            width="100%"
            flexShrink={0}
            fg={heading ? palette.accent : palette.text}
            content={
              new StyledText(
                inline(
                  text.tokens ?? [
                    {
                      type: "text",
                      raw: token.raw,
                      text: text.text ?? token.raw,
                    },
                  ],
                  colors,
                  heading ? TextAttributes.BOLD : 0,
                  heading ? colors.accent : colors.text,
                ),
              )
            }
            selectable
          />
        );
      }
    }
  };

  return (
    <box
      id={id}
      width="100%"
      flexDirection="column"
      paddingLeft={1}
      flexShrink={0}
    >
      {renderBlocks(parsed)}
    </box>
  );
}
