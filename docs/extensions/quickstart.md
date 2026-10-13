# Первый пакет

[Разработка расширений](README.md) · [Формат](package.md) · [Tools и commands](tools-commands.md)

Создайте отдельный TypeScript-проект. Установите npm tarball `chiselcode-0.6.25.tgz` из assets релиза для типов (`npm install --save-dev /путь/chiselcode-0.6.25.tgz`); его не нужно размещать рядом с runtime пакетом. Исходник:

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

Создайте manifest по [формату пакета](package.md). Разместите только готовый `.mjs`, manifest и assets в `ChiselCode Home/extensions/author.feature`, получив базовый путь через `chisel extensions path`. Выполните [inspect и exact trust](../extensions.md#проверка-и-доверие), затем перезапустите приложение.

Полный самостоятельный пример: [examples/extensions/project-notes](../../examples/extensions/project-notes/index.ts) и его [manifest](../../examples/extensions/project-notes/chisel-extension.json). Пример содержит чтение, planned write, полезную команду, side-query, context, chat и три UI slots с paginated details. Он не входит в defaultExtensions или установщики. Для authoring используйте types из packed distribution, а не импорт `../../src`.

Factory выполняется один раз для approved identity/digest в процессе; `activate` — для каждого canonical workspace. Храните workspace state внутри `activate`, а не в глобальной переменной factory.
