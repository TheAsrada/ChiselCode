/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { TextTableRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { THEMES } from "../../src/ui/appearance.js";
import { FormattedMessage } from "../../src/ui/opentui-message.js";

type Setup = Awaited<ReturnType<typeof testRender>>;
async function render(setup: Setup) {
  await act(async () => {
    await setup.renderOnce();
    await setup.renderOnce();
  });
  const node = setup.renderer.root.findDescendantById("answer");
  if (!node) throw new Error("Missing answer");
  return setup
    .captureCharFrame()
    .split("\n")
    .slice(node.y, node.y + node.height)
    .map((row) => row.trim());
}
function view(content: string, width: number) {
  return (
    <FormattedMessage
      id="answer"
      content={content}
      width={width}
      palette={THEMES.obsidian}
    />
  );
}
function findTable(setup: Setup): TextTableRenderable | undefined {
  const find = (
    node: typeof setup.renderer.root,
  ): TextTableRenderable | undefined => {
    if (node instanceof TextTableRenderable) return node;
    for (const child of node.getChildren()) {
      const found = find(child);
      if (found) return found;
    }
  };
  return find(setup.renderer.root);
}

test("prose paragraphs use adjacent rows without empty Markdown separator rows", async () => {
  const setup = await testRender(
    view("\n\nПервый абзац\r\n\r\n\r\n\r\nВторой абзац\r\n\r\n", 40),
    { width: 40, height: 30 },
  );
  try {
    expect(await render(setup)).toEqual(["Первый абзац", "Второй абзац"]);
  } finally {
    act(() => setup.renderer.destroy());
  }
});

for (const width of [16, 40, 80, 120]) {
  test(`wrapped list items are aligned and have no empty rows at ${width} columns`, async () => {
    const word = "a".repeat(width * 2);
    const setup = await testRender(
      view(`- ${word}\n\n- ${word}\n  - nested\n- 👩‍💻 汉字 é`, width),
      { width, height: 80 },
    );
    try {
      const rows = await render(setup);
      expect(rows.filter((row) => row.includes("•"))).toHaveLength(4);
      expect(rows.every((row) => !!row.replace(/^\|\s*/, "").trim())).toBe(
        true,
      );
      const body = rows.join("").replace(/[\s|•]/g, "");
      expect(body).toContain(word.repeat(2));
      expect(body).toContain("nested");
      expect(body).toContain("👩‍💻汉字é");
      expect(body).not.toMatch(/[\ufffd\p{Cs}]/u);
      expect(rows.join("\n")).not.toContain("Помощник");
    } finally {
      act(() => setup.renderer.destroy());
    }
  });
}

test("ordered lists, tasks, escapes and inline formatting retain their meaning", async () => {
  const setup = await testRender(
    view(
      "4. **Первое**\n5. Второе\n\n- [x] Готово\n- [ ] Осталось\n\n_Курсив_ и `read_file` и \\*literal\\* &amp; [ссылка](https://example.com)",
      100,
    ),
    { width: 100, height: 40 },
  );
  try {
    const text = (await render(setup)).join("\n");
    for (const label of [
      "4.",
      "5.",
      "[x]",
      "[ ]",
      "Курсив",
      "read_file",
      "*literal*",
      "&",
      "ссылка (https://example.com)",
    ])
      expect(text).toContain(label);
    expect(text).not.toContain("**Первое**");
    expect(text).not.toContain("&amp;");
  } finally {
    act(() => setup.renderer.destroy());
  }
});

test("blank lines and Markdown-looking characters inside code are preserved", async () => {
  const setup = await testRender(
    view(
      "```ts\nconst first = 1;\n\n\n* literal bullet\n```\n\nПоследний абзац",
      60,
    ),
    { width: 60, height: 40 },
  );
  try {
    const rows = await render(setup);
    const start = rows.findIndex((row) => row.includes("const first"));
    expect(
      rows
        .slice(start, start + 4)
        .map((row) => row.replace(/^\|\s?/, "").trim()),
    ).toEqual(["const first = 1;", "", "", "* literal bullet"]);
    expect(rows.at(-1)).toBe("Последний абзац");
  } finally {
    act(() => setup.renderer.destroy());
  }
});

const table =
  "| Инструмент | Назначение |\n| --- | --- |\n| `read_file` | Чтение файла |\n| `edit_file` | Правка \\| текста |";
for (const width of [16, 40, 80, 120]) {
  test(`tables preserve cells and use a readable layout at ${width} columns`, async () => {
    const setup = await testRender(view(table, width), { width, height: 80 });
    try {
      const rows = await render(setup);
      const native = findTable(setup);
      expect(!!native).toBe(width >= 40);
      if (native) {
        expect(rows.every((row) => !!row.replace(/^\|\s*/, "").trim())).toBe(
          true,
        );
        const cells = native.content.map((row) =>
          row.map((cell) => cell?.map((chunk) => chunk.text).join("")),
        );
        expect(cells).toEqual([
          ["Инструмент", "Назначение"],
          ["read_file", "Чтение файла"],
          ["edit_file", "Правка | текста"],
        ]);
        expect(native.width).toBeLessThanOrEqual(width);
      } else {
        const text = rows.join("").replace(/\s/g, "");
        expect(text).toContain("Инструмент:");
        expect(text).toContain("read_file");
        expect(text).toContain("edit_file");
      }
      expect(rows.join("\n")).not.toContain("---");
      expect(rows.join("\n")).not.toMatch(/[\ufffd\p{Cs}]/u);
    } finally {
      act(() => setup.renderer.destroy());
    }
  });
}

test("streaming reuses the table and final cells survive a narrow resize", async () => {
  let update!: (content: string) => void;
  function Harness() {
    const [content, setContent] = useState(
      "| Имя | Описание |\n| --- | --- |\n| Alpha | Начало |",
    );
    update = setContent;
    return (
      <FormattedMessage
        id="answer"
        content={content}
        streaming
        palette={THEMES.obsidian}
      />
    );
  }
  const setup = await testRender(<Harness />, { width: 80, height: 50 });
  try {
    await render(setup);
    const native = findTable(setup);
    expect(native).toBeTruthy();
    const source =
      "| Имя | Описание |\n| --- | --- |\n| Alpha | Начало |\n| Beta | Завершено |";
    for (let i = source.indexOf("\n| Beta") + 1; i <= source.length; i++) {
      await act(async () => {
        update(source.slice(0, i));
      });
      await render(setup);
      expect(findTable(setup)).toBe(native);
      if (source.slice(0, i).endsWith("\n|")) expect(native?.height).toBe(2);
    }
    await act(async () => {
      setup.resize(20, 50);
    });
    const text = (await render(setup)).join("").replace(/\s/g, "");
    expect(findTable(setup)).toBeUndefined();
    expect(text).toContain("Alpha");
    expect(text).toContain("Beta");
    expect(text).toContain("Завершено");
  } finally {
    act(() => setup.renderer.destroy());
  }
});

test("entity decoding cannot reintroduce terminal commands", async () => {
  const setup = await testRender(
    view("До &#27;]0;secret title&#7; после &#x85; текста", 80),
    { width: 80, height: 20 },
  );
  try {
    const text = (await render(setup)).join("\n");
    expect(text).toContain("До");
    expect(text).toContain("после");
    expect(text).not.toContain("secret title");
    expect(text).not.toContain("&#");
  } finally {
    act(() => setup.renderer.destroy());
  }
});
