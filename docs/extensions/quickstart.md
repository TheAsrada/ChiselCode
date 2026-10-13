# Первый пакет

[Разработка расширений](README.md) · [Формат](package.md) · [Tools и commands](tools-commands.md)

Создайте отдельный TypeScript-проект. Установите актуальный npm tarball `chiselcode-0.6.26.tgz` или новее из assets релиза для типов (`npm install --save-dev /путь/chiselcode-0.6.26.tgz`); его не нужно размещать рядом с runtime пакетом. Базовый loader/SDK требует 0.6.25+, типы тем `ThemeContribution`/`ThemeToken` — 0.6.26+. Исходник:

```ts
import type { ExtensionFactory } from "chiselcode/extension-sdk";

const factory: ExtensionFactory = ({sdk, manifest}) => ({
  id: manifest.id,
  version: manifest.version,
  apiVersion: 1,
  entry: manifest.entry,
  activate(ctx) {
    ctx.tools.register(sdk.defineTool<{path: string}>({
      name: "read_text",
      description: "Прочитать текст проекта",
      effect: "read",
      inputSchema: {
        type: "object", properties: {path: {type: "string", minLength: 1}},
        required: ["path"], additionalProperties: false
      },
      prepare(invocation, input) { return invocation.plan.readText(input.path); },
      execute(invocation) { return invocation.effects.run(); }
    }));
  }
});
export default factory;
```

Соберите `bun build index.ts --target bun --outfile index.mjs`. Type-only import исчезает. Все сторонние runtime dependencies должны попасть в bundle; runtime не запускает npm install и не разрешает dependencies через проект пользователя.

Создайте manifest по [формату пакета](package.md). Разместите только готовый `.mjs`, manifest и assets в отдельной папке. В сборке с менеджером пакетов выполните `chisel extensions inspect ./package --json`, затем `chisel extensions install ./package --json`. Установка по умолчанию выключена и не выдаёт доверие. Для installed location из результата выполните [exact trust](../extensions.md#проверка-и-доверие), затем перезапустите приложение. Старый workflow 0.6.25/0.6.26 с вручную подготовленной папкой внутри Home/extensions продолжает работать; installer не присваивает себе её ownership.

Npm tarball ChiselCode нужен для приложения и SDK declarations. Это **не ZIP расширения** и не аргумент extension install. [Упаковка ZIP и управление версиями](package-management.md).

Полный самостоятельный пример: [examples/extensions/project-notes](../../examples/extensions/project-notes/index.ts) и его [manifest](../../examples/extensions/project-notes/chisel-extension.json). Пример содержит чтение, planned write, полезную команду, side-query, context, chat и три UI slots с paginated details. Он не входит в defaultExtensions или установщики. Для authoring используйте types из packed distribution, а не импорт `../../src`.

Factory выполняется один раз для approved identity/digest в процессе; `activate` — для каждого canonical workspace. Храните workspace state внутри `activate`, а не в глобальной переменной factory.
