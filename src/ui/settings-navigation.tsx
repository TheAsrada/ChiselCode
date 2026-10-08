/** @jsxImportSource @opentui/react */
import type { Palette } from "./appearance.js";
import type { SettingsSearchResult } from "./settings-catalog.js";
import { useTerminalDecoration } from "./terminal-decoration.js";
import { terminalLine } from "./terminal-text.js";

export function SettingsNavigation({
  results,
  selected,
  height,
  width,
  palette,
  query,
  focused,
  onSelect,
  onMove,
  separated = false,
}: {
  results: readonly SettingsSearchResult[];
  selected: number;
  height: number;
  width: number;
  palette: Palette;
  query: string;
  focused: boolean;
  onSelect(index: number): void;
  onMove(index: number): void;
  separated?: boolean;
}) {
  const { borderChars, unicode } = useTerminalDecoration();
  const contentWidth = Math.max(1, width - (separated ? 3 : 0));
  const availableRows = Math.max(1, height - (separated ? 3 : 0));
  const rows: Array<{
    key: string;
    group?: string;
    index?: number;
    description?: string;
  }> = [];
  let previous = "";
  for (const [index, result] of results.entries()) {
    if (!query && result.section.group !== previous) {
      if (previous && separated)
        rows.push({ key: `gap-${previous}`, group: "" });
      previous = result.section.group;
      rows.push({ key: `group-${previous}`, group: previous });
    }
    const key = `${result.section.id}:${result.field ?? "section"}`;
    rows.push({ key, index });
    if (query && width > 38) {
      rows.push({
        key: `path-${key}`,
        group: `${result.section.group} / ${result.section.title}`,
      });
      rows.push({
        key: `description-${key}`,
        description: result.section.description,
      });
    }
  }
  const position = rows.findIndex((row) => row.index === selected);
  const first = Math.max(
    0,
    Math.min(position - availableRows + 1, rows.length - availableRows),
  );
  return (
    <box
      id="settings-navigation"
      width={width}
      height="100%"
      flexDirection="column"
      overflow="hidden"
      backgroundColor={separated ? palette.bg : palette.surface}
      border={separated ? ["right"] : []}
      borderColor={palette.border}
      customBorderChars={borderChars}
      paddingLeft={separated ? 1 : 0}
      paddingRight={separated ? 1 : 0}
      onMouseScroll={(event) => {
        event.stopPropagation();
        const direction = event.scroll?.direction;
        if (direction === "up" || direction === "down")
          onMove(
            Math.max(
              0,
              Math.min(
                results.length - 1,
                selected + (direction === "up" ? -1 : 1),
              ),
            ),
          );
      }}
    >
      {separated && (
        <text height={2} fg={palette.muted}>
          <strong>Разделы</strong>
        </text>
      )}
      {!results.length && (
        <text fg={palette.muted}>Нет результатов. Esc очистить</text>
      )}
      {rows.slice(first, first + availableRows).map((row) =>
        row.index === undefined ? (
          <text key={row.key} height={1} fg={palette.muted}>
            {terminalLine(row.description ?? row.group ?? "", contentWidth)}
          </text>
        ) : (
          // biome-ignore lint/a11y/noStaticElementInteractions: Navigation also uses Up/Down and Enter.
          <box
            key={row.key}
            id={`settings-route-${results[row.index]?.section.id}`}
            height={1}
            flexShrink={0}
            backgroundColor={
              row.index === selected
                ? palette.raised
                : separated
                  ? palette.bg
                  : palette.surface
            }
            onMouseUp={(event) => {
              if (event.button !== 0) return;
              event.stopPropagation();
              onSelect(row.index ?? 0);
            }}
          >
            <text
              height={1}
              fg={
                row.index === selected && focused
                  ? palette.accent
                  : palette.text
              }
            >
              {terminalLine(
                `${row.index === selected ? (focused ? "> " : "| ") : "  "}${results[row.index]?.title ?? ""}`,
                contentWidth,
              )}
            </text>
          </box>
        ),
      )}
      {separated && <box flexGrow={1} minHeight={0} />}
      {separated && (
        <text height={1} fg={palette.muted}>
          {unicode ? "↑↓ · Enter открыть" : "Up/Down · Enter"}
        </text>
      )}
    </box>
  );
}
