/** @jsxImportSource @opentui/react */
// Прототип предложения: демонстрационные данные, без Git, сети и операций с проектом.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useTerminalDimensions } from "@opentui/react";
import { act, useState } from "react";
import { themePalette } from "../src/themes/palettes.js";
import { terminalLine } from "../src/ui/terminal-text.js";

type Screen =
  | "list"
  | "detail"
  | "create"
  | "changes"
  | "remove"
  | "diagnostic";
const trees = [
  {
    name: "avtobuys",
    kind: "Основной проект",
    status: "Текущая папка · main",
    path: "C:/Projects/avtobuys",
    files: 0,
    tabs: 1,
  },
  {
    name: "Новая аналитика",
    kind: "Копия ChiselCode",
    status: "3 файла изменены · 1 вкладка",
    path: "ChiselCode Home/worktrees/analytics",
    files: 3,
    tabs: 1,
  },
  {
    name: "Проверка сборки",
    kind: "Копия ChiselCode",
    status: "Чистая · вкладок и задач нет",
    path: "ChiselCode Home/worktrees/build-check",
    files: 0,
    tabs: 0,
  },
  {
    name: "Ручная проверка",
    kind: "Другая копия Git",
    status: "Создана вне ChiselCode",
    path: "C:/Projects/avtobuys-review",
    files: 0,
    tabs: 0,
  },
] as const;

function Prototype({
  paper = false,
  onExit,
}: {
  paper?: boolean;
  onExit(): void;
}) {
  const p = themePalette(paper ? "paper" : "obsidian");
  const { width, height } = useTerminalDimensions();
  const [screen, setScreen] = useState<Screen>("list");
  const [selected, setSelected] = useState(1);
  const [focus, setFocus] = useState<"list" | "actions" | "search">("list");
  const [action, setAction] = useState(0);
  const [query, setQuery] = useState("");
  const [label, setLabel] = useState("");
  const [notice, setNotice] = useState("");
  const wide = width >= 100 && height >= 28;
  const compact = width < 60 || height < 24;
  const tiny = width < 32 || height < 12;
  const footer =
    screen === "create"
      ? "Enter продолжить · Esc назад"
      : screen !== "list" && screen !== "detail"
        ? "Esc — вернуться к списку"
        : screen === "detail" || focus === "actions"
          ? "↑↓ действия · Enter выбрать · Esc назад"
          : width < 60
            ? "↑↓  Enter открыть  Esc назад"
            : width < 100
              ? "↑↓ выбор · Enter открыть · N новая · / поиск · Esc назад"
              : "↑↓ выбор   Enter открыть   Tab действия   N новая   / поиск   R обновить   D пример ошибки   Esc назад";
  const item = trees[selected] ?? trees[0];
  const owned = selected === 1 || selected === 2;
  const available = trees
    .map((tree, index) => ({ ...tree, index }))
    .filter((tree) => tree.name.toLowerCase().includes(query.toLowerCase()));
  const actions = owned
    ? [
        "Открыть в новой вкладке",
        "Посмотреть изменения",
        "Перенести в основной проект",
        "Удалить копию…",
      ]
    : selected === 0
      ? ["Вернуться в чат", "Закрыть текущую вкладку"]
      : ["Показать сведения", "Почему нет удаления?"];
  const choose = (index: number) => {
    setSelected(index);
    setAction(0);
    setNotice("");
  };
  const activate = (index: number) => {
    if (owned && index === 1) setScreen("changes");
    else if (owned && index === 2)
      setNotice(
        "Прототип: сначала проверяем diff и целевую папку, затем запрашиваем разрешение.",
      );
    else if (owned && index === 3) {
      if (item.files || item.tabs)
        setNotice(
          "Удаление недоступно: есть изменения и открытая вкладка. Файлы сохранены.",
        );
      else setScreen("remove");
    } else if (selected === 0 && index === 1)
      setNotice(
        "Прототип: закрывается только вкладка; папка и история остаются.",
      );
    else if (selected === 3)
      setNotice(
        "ChiselCode не управляет удалением этой копии. Обычные права работы с файлами определяются отдельно.",
      );
    else
      setNotice(
        "Прототип: здесь откроется вкладка выбранного проекта; файлы не меняются.",
      );
  };
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      onExit();
      return;
    }
    if (key.name === "escape") {
      key.preventDefault();
      key.stopPropagation();
      if (focus === "search") {
        setFocus("list");
        return;
      }
      if (screen !== "list") {
        setScreen("list");
        setFocus("list");
        return;
      }
      onExit();
      return;
    }
    if (screen === "create" || focus === "search") return;
    if (key.ctrl || key.meta || key.option) return;
    if (key.name === "n" && screen === "list") {
      setScreen("create");
      return;
    }
    if (key.name === "d" && screen === "list") {
      setScreen("diagnostic");
      return;
    }
    if (key.name === "/" && screen === "list") {
      setFocus("search");
      return;
    }
    if (key.name === "r" && screen === "list") {
      setNotice("Прототип: список обновлён из демонстрационных данных.");
      return;
    }
    if (key.name === "tab") {
      key.preventDefault();
      key.stopPropagation();
      if (screen === "list" && !wide) {
        setScreen("detail");
        setFocus("actions");
      } else setFocus(focus === "list" ? "actions" : "list");
      return;
    }
    if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      key.stopPropagation();
      const delta = key.name === "up" ? -1 : 1;
      if (screen === "list" && focus === "list") {
        const pos = available.findIndex((tree) => tree.index === selected);
        const next =
          available[Math.max(0, Math.min(available.length - 1, pos + delta))];
        if (next) choose(next.index);
      } else
        setAction(Math.max(0, Math.min(actions.length - 1, action + delta)));
      return;
    }
    if (key.name === "return" || key.name === "enter" || key.name === "space") {
      key.preventDefault();
      key.stopPropagation();
      if (screen === "list" && focus === "list") {
        if (!available.length) return;
        setScreen("detail");
        setFocus("actions");
      } else if (
        screen === "detail" ||
        (screen === "list" && focus === "actions")
      )
        activate(action);
    }
  });
  const line = (text: string, color = p.text, lines = 1) => (
    <text fg={color} height={lines} flexShrink={0}>
      {lines === 1 ? terminalLine(text, Math.max(1, width - 8)) : text}
    </text>
  );
  const buttons = () => (
    <box flexDirection="column" gap={height >= 28 ? 1 : 0} marginTop={1}>
      {actions.map((name, index) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI box is not a DOM node; the same actions have keyboard handlers.
        <box
          key={name}
          height={1}
          backgroundColor={
            action === index && focus === "actions" ? p.raised : p.surface
          }
          onMouseUp={(event) => {
            if (event.button === 0 && !event.isDragging) {
              setAction(index);
              setFocus("actions");
              activate(index);
            }
          }}
        >
          <text fg={index === 3 ? p.muted : p.accent}>
            {terminalLine(
              `${action === index && focus === "actions" ? "›" : " "} ${name}${owned && index === 3 && (item.files || item.tabs) ? " · недоступно" : ""}`,
              wide ? width - 53 : width - 8,
            )}
          </text>
        </box>
      ))}
    </box>
  );
  const detail = () => (
    <box
      flexDirection="column"
      flexGrow={1}
      width={wide ? width - 47 : width - 4}
      padding={1}
      backgroundColor={p.surface}
    >
      {wide && line(item.kind.toUpperCase(), p.muted)}
      <text fg={p.text} height={wide ? 2 : 1}>
        <strong>{item.name}</strong>
      </text>
      {line(item.status, item.files ? p.yellow : p.green)}
      <text fg={p.muted} height={wide ? 2 : 1} wrapMode="char">
        {terminalLine(item.path, wide ? width - 51 : width - 8)}
      </text>
      {wide &&
        line(
          selected === 0
            ? "Ветка: main · HEAD 89e2ac8"
            : owned
              ? "База: 89e2ac8 · без отдельной ветки"
              : "Сведения получены через Git",
          p.muted,
        )}
      {!compact && (
        <text
          fg={p.text}
          width={wide ? width - 51 : width - 8}
          marginTop={1}
          height={wide ? 3 : 2}
        >
          {selected === 0
            ? "Это основной проект. Работа с файлами подчиняется обычным разрешениям проекта."
            : owned
              ? "Результат остаётся в этой папке. Основной проект изменится после явного переноса."
              : "ChiselCode не создавал эту копию и не удаляет её через менеджер. Это не запрет работы с файлами."}
        </text>
      )}
      {buttons()}
      {owned && (item.files > 0 || item.tabs > 0) && (
        <text
          fg={p.muted}
          width={wide ? width - 51 : width - 8}
          marginTop={wide ? 1 : 0}
          height={wide ? 2 : 1}
        >
          {wide
            ? "Для удаления: завершить вкладки и задачи, затем разобрать оставшиеся файлы."
            : "Удаление блокируют изменения и вкладка."}
        </text>
      )}
    </box>
  );
  const listing = () => (
    <box
      flexDirection="column"
      width={wide ? 43 : "100%"}
      flexShrink={0}
      padding={1}
    >
      <box height={2} flexShrink={0}>
        {focus === "search" ? (
          <input
            focused
            value={query}
            onInput={(value) => {
              setQuery(value);
              const match = trees.findIndex((tree) =>
                tree.name.toLowerCase().includes(value.toLowerCase()),
              );
              if (match >= 0) choose(match);
            }}
            onSubmit={() => setFocus("list")}
            placeholder="Название копии…"
            textColor={p.text}
            backgroundColor={p.raised}
          />
        ) : (
          <text fg={p.muted}>
            {query ? `Поиск: ${query}` : "/  Найти рабочую копию"}
          </text>
        )}
      </box>
      {available.map((tree) => (
        <box
          key={tree.index}
          flexDirection="column"
          flexShrink={0}
          marginBottom={1}
        >
          {(tree.index === 0 || tree.index === 1 || tree.index === 3) && (
            <text fg={p.muted} height={1}>
              {tree.index === 0
                ? "ОСНОВНОЙ ПРОЕКТ"
                : tree.index === 1
                  ? "КОПИИ CHISELCODE"
                  : "ДРУГИЕ КОПИИ GIT"}
            </text>
          )}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI selection supports the same rows through arrow keys and Enter. */}
          <box
            flexDirection="column"
            height={3}
            paddingLeft={1}
            backgroundColor={selected === tree.index ? p.raised : p.bg}
            onMouseUp={(event) => {
              if (event.button === 0 && !event.isDragging) {
                choose(tree.index);
                setScreen("detail");
                setFocus("actions");
              }
            }}
          >
            <text fg={selected === tree.index ? p.accent : p.text}>
              {terminalLine(
                `${selected === tree.index ? "› " : "  "}${tree.name}`,
                wide ? 39 : width - 7,
              )}
            </text>
            <text fg={p.muted}>
              {terminalLine(tree.status, wide ? 39 : width - 7)}
            </text>
          </box>
        </box>
      ))}
      {!available.length && line("Совпадений нет. Измените поиск.", p.muted)}
    </box>
  );
  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      backgroundColor={p.bg}
      padding={tiny ? 0 : 1}
    >
      <box height={tiny ? 2 : 3} flexShrink={0} flexDirection="column">
        <text fg={p.accent}>
          <strong>{terminalLine("Рабочие копии", width - 2)}</strong>
        </text>
        <text fg={p.muted}>
          {terminalLine("ПРОТОТИП · демонстрационные данные", width - 2)}
        </text>
      </box>
      {tiny ? (
        <box flexGrow={1} flexDirection="column">
          <text fg={p.text}>{terminalLine(item.name, width)}</text>
          <text fg={p.muted}>{terminalLine(item.kind, width)}</text>
          <text fg={p.yellow}>Мало места</text>
          <text fg={p.muted}>Esc назад</text>
        </box>
      ) : (
        <box
          border
          borderStyle="rounded"
          borderColor={p.border}
          flexGrow={1}
          minHeight={1}
          flexDirection="column"
        >
          <scrollbox flexGrow={1} minHeight={1}>
            {screen === "list" ? (
              <box flexDirection={wide ? "row" : "column"}>
                {listing()}
                {wide && available.length > 0 && detail()}
              </box>
            ) : screen === "detail" ? (
              detail()
            ) : screen === "create" ? (
              <box padding={1} flexDirection="column" gap={wide ? 1 : 0}>
                {line("Новая изолированная копия", p.accent)}
                {line("Название задачи", p.muted)}
                <input
                  focused
                  value={label}
                  onInput={setLabel}
                  placeholder="Например: Новая аналитика"
                  textColor={p.text}
                  backgroundColor={p.raised}
                  onSubmit={() =>
                    setNotice(
                      "Прототип: следующий шаг — проверить базу и подтвердить создание.",
                    )
                  }
                />
                {line("Из проекта: avtobuys · main · 89e2ac8")}
                <text fg={p.muted} height={3}>
                  Копируются файлы сохранённого коммита. Текущие правки и
                  зависимости не переносятся. Создание не обновляет проект с
                  GitHub.
                </text>
                {line("Enter — продолжить к подтверждению", p.accent)}
              </box>
            ) : screen === "diagnostic" ? (
              <box padding={1} flexDirection="column" gap={wide ? 1 : 0}>
                {line("Команда не запущена", p.yellow)}
                <text fg={p.text} height={3}>
                  Передан неизвестный ID рабочей копии. Это ошибка параметра
                  команды; доступ к основному проекту этой проверкой не
                  оценивался.
                </text>
                {line("Причина: targetWorktreeId = нулевой UUID", p.muted)}
                <text fg={p.text} height={3}>
                  Для команды в текущем проекте поле targetWorktreeId нужно
                  опустить. Не требуется создавать новую копию или повторно
                  выдавать разрешение.
                </text>
                {line("Что изменилось: ничего, процесс не запускался", p.green)}
                {line("Технические сведения: INVALID_TOOL_INPUT", p.muted)}
              </box>
            ) : screen === "changes" ? (
              <box padding={1} flexDirection="column" gap={wide ? 1 : 0}>
                {line("Перенос результата → основной проект", p.accent)}
                {line("Источник: Новая аналитика")}
                {line("Назначение: C:/Projects/avtobuys", p.yellow)}
                {line("3 файла · +42 −8 · проверка конфликтов", p.muted)}
                {line("  M src/analytics.ts     +24 −6")}
                {line("  M tests/analytics.ts   +12 −2")}
                {line("  A docs/analytics.md     +6")}
                <text fg={p.muted} height={3}>
                  В продукте здесь будет штатный просмотр diff. Перед записью
                  состояние проверяется снова. Просмотр ничего не переносит.
                </text>
                {line(
                  "Следующий шаг: проверить → подтвердить перенос",
                  p.accent,
                )}
              </box>
            ) : (
              <box padding={1} flexDirection="column" gap={wide ? 1 : 0}>
                {line("Удалить папку копии?", p.yellow)}
                {line(item.name)}
                <text fg={p.muted} height={2}>
                  {item.path}
                </text>
                <text fg={p.text} height={3}>
                  Будет удалена эта отдельная папка. Основной проект останется.
                  Копия проверяется повторно перед удалением.
                </text>
                {line("Чистая · нет открытых вкладок и процессов", p.green)}
                {line("В продукте: [ Отмена ]  [ Удалить копию ]", p.accent)}
                {line("Прототип не выполняет удаление.", p.muted)}
              </box>
            )}
          </scrollbox>
        </box>
      )}
      {!tiny && (
        <box
          height={notice ? 4 : 2}
          flexShrink={0}
          flexDirection="column"
          paddingTop={1}
        >
          {notice && (
            <text fg={p.yellow} height={2}>
              {notice}
            </text>
          )}
          <text fg={p.muted}>{terminalLine(footer, width - 2)}</text>
        </box>
      )}
    </box>
  );
}

const args = process.argv.slice(2);
const captureAt = args.indexOf("--capture");
if (captureAt >= 0) {
  const directory = args[captureAt + 1];
  assert.ok(directory, "Укажите каталог после --capture");
  await mkdir(directory, { recursive: true });
  const { testRender } = await import("@opentui/react/test-utils");
  for (const paper of [false, true]) {
    let exited = false;
    const t = await testRender(
      <Prototype
        paper={paper}
        onExit={() => {
          exited = true;
        }}
      />,
      { width: 120, height: 36, exitOnCtrlC: false },
    );
    const ready = async (text: string) => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        await act(async () => {
          await Bun.sleep(10);
          await t.renderOnce();
        });
        if (t.captureCharFrame().includes(text)) return;
      }
      assert.fail(`Экран не готов: ${text}\n${t.captureCharFrame()}`);
    };
    const key = async (name: string) => {
      await act(async () => {
        t.mockInput.pressKey(name);
        // Standalone Esc is buffered by the terminal decoder. Screen readiness
        // is asserted separately below; this only lets that decoder flush.
        if (name === "ESCAPE") await Bun.sleep(120);
        await t.renderOnce();
      });
    };
    const capture = async (name: string) => {
      const frame = t.captureSpans();
      const filename = join(
        directory,
        `${paper ? "paper" : "obsidian"}-${name}`,
      );
      await writeFile(`${filename}.txt`, t.captureCharFrame());
      await writeFile(
        `${filename}.json`,
        JSON.stringify({
          ...frame,
          lines: frame.lines.map((line) => ({
            spans: line.spans.map((span) => ({
              ...span,
              fg: span.fg.toInts(),
              bg: span.bg.toInts(),
            })),
          })),
        }),
      );
    };
    try {
      await ready("КОПИИ CHISELCODE");
      await capture("list-120x36");
      await key("ARROW_UP");
      await ready("Это основной проект");
      await capture("origin-120x36");
      await act(async () => {
        t.resize(80, 24);
      });
      await key("d");
      await ready("Команда не запущена");
      await capture("diagnostic-80x24");
      await key("ESCAPE");
      assert.equal(exited, false);
      await key("n");
      await ready("Новая изолированная копия");
      await act(async () => {
        await t.mockInput.pasteBracketedText("Проверка оплаты");
      });
      await ready("Проверка оплаты");
      await capture("create-80x24");
      await key("ESCAPE");
      await key("ARROW_DOWN");
      await key("RETURN");
      await ready("Перенести в основной проект");
      await key("ARROW_DOWN");
      await key("RETURN");
      await ready("Перенос результата");
      await capture("changes-80x24");
      await key("ESCAPE");
      await key("ARROW_DOWN");
      await key("RETURN");
      for (let i = 0; i < 3; i++) await key("ARROW_DOWN");
      await key("RETURN");
      await ready("Удалить папку копии?");
      await capture("remove-80x24");
      await key("ESCAPE");
      await act(async () => {
        t.resize(40, 20);
      });
      await key("RETURN");
      await ready("Проверка сборки");
      await capture("detail-40x20");
      await act(async () => {
        t.resize(24, 8);
      });
      await ready("Мало места");
      await capture("tiny-24x8");
      await act(async () => {
        t.resize(80, 24);
      });
      await key("ESCAPE");
      await key("n");
      await ready("Проверка оплаты");
      await key("ESCAPE");
      await key("/");
      await act(async () => {
        await t.mockInput.pasteBracketedText("несуществующая");
      });
      await ready("Совпадений нет");
      await key("ESCAPE");
      await key("ESCAPE");
      assert.equal(exited, true);
    } finally {
      act(() => {
        t.renderer.destroy();
      });
    }
  }
  process.stdout.write(
    "Прототип OpenTUI: 2 темы, 8 кадров каждой, клавиатура, поиск, формы, resize и возврат — OK. Git/проект не вызывались.\n",
  );
} else {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);
  let finish: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  try {
    root.render(
      <Prototype paper={args.includes("--paper")} onExit={() => finish?.()} />,
    );
    await done;
  } finally {
    root.unmount();
    renderer.destroy();
  }
}
