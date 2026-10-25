import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDocumentation, markdownPage } from "../../scripts/check-docs.js";

test("Markdown links retain lines, ignore code, and support references, HTML, titles and balanced destinations", () => {
  const source = [
    "# Заголовок `API`",
    '[Открыть](<папка/мой файл.md#якорь> "Название (пример)")',
    "![Кадр](assets/a(b).png)",
    "[Справка][guide] и [guide]",
    '[guide]: page.md#раздел "Описание"',
    "`[Код](missing.md)`",
    "````md",
    "```",
    "[Пример](missing.md)",
    "````",
    "<!-- [Скрыто](hidden.md) -->",
    '<a id="ручной-якорь" href="page.md#x&amp;y">Переход</a>',
  ].join("\n");
  const result = markdownPage(source);
  expect(result.links.map((link) => link.target)).toEqual([
    "папка/мой файл.md#якорь",
    "assets/a(b).png",
    "page.md#раздел",
    "page.md#раздел",
    "page.md#x&y",
  ]);
  expect(result.links[0]?.line).toBe(2);
  expect(result.links.at(-1)?.line).toBe(12);
  expect(result.anchors.has("заголовок-api")).toBe(true);
  expect(result.anchors.has("ручной-якорь")).toBe(true);
});

test("GitHub anchors include Setext headings and collision suffixes while examples stay excluded", () => {
  const result = markdownPage(
    "# A\n# A\n# A-1\nНазвание\n========\n~~~md\n# Скрыто\n~~~\n## `/model` — выбор\n## `foo_bar` и _текст_\n",
  );
  expect([...result.anchors]).toEqual([
    "a",
    "a-1",
    "a-1-1",
    "название",
    "model--выбор",
    "foo_bar-и-текст",
  ]);
});

test("documentation audit reports missing files, anchors, unreachable pages and root escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-docs-"));
  try {
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "README.md"), "[Справка](docs/guide.md)\n");
    await writeFile(
      join(root, "docs/guide.md"),
      "# Справка\n[Файл](missing.md)\n[Якорь](#нет)\n[За корень](../../outside.md)\n[URL](%zz.md)\n",
    );
    await writeFile(join(root, "docs/orphan.md"), "# Потерянная страница\n");
    const result = await checkDocumentation(root);
    expect(result.pages).toBe(3);
    expect(result.issues).toHaveLength(5);
    expect(result.issues.map((issue) => issue.line)).toEqual([2, 3, 4, 5, 1]);
    expect(result.issues.at(-1)?.file).toBe("docs/orphan.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("linked documentation with encoded paths, images and a valid fragment is checked without a network", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-docs-"));
  try {
    await mkdir(join(root, "docs"));
    await writeFile(
      join(root, "README.md"),
      "[Страница](docs/Пример%20(1).md?plain=1#раздел)\n[Внешний адрес](https://example.invalid/no-network)\n",
    );
    await writeFile(
      join(root, "docs/Пример (1).md"),
      "# Раздел\n![Фото](image.png)\n[Домой](../README.md)\n",
    );
    await writeFile(join(root, "docs/image.png"), new Uint8Array([0]));
    const result = await checkDocumentation(root);
    expect(result.pages).toBe(2);
    expect(result.links).toBe(3);
    expect(result.issues).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
