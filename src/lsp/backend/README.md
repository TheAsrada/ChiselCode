# Стандартный TypeScript/JavaScript backend

`typescript.json.gz` — воспроизводимый gzip JSON с файлами официальных
`typescript-language-server@6.0.1` и `typescript@6.0.3`. Включены JS server,
TypeScript runtime/standard declarations, package metadata и исходные LICENSE /
ThirdPartyNoticeText. Исходники не изменены. Обе поставки используют Apache-2.0;
дополнительные notices сохранены внутри payload.

Обновление выполняет maintainer, а не пользовательский runtime:

```sh
npm install --prefix /tmp/chisel-lsp-vendor --ignore-scripts typescript-language-server@6.0.1 typescript@6.0.3
bun scripts/vendor-lsp-backend.ts /tmp/chisel-lsp-vendor/node_modules
```

Скрипт проверяет версии и создаёт `version.ts` с SHA-256. Payload попадает в обычный
npm build и compiled binary через Bun file loader. Auto распаковывает его лениво
в private versioned `chiselHomeDir()/lsp`, проверяя содержимое перед запуском.
Bundled Bun runtime обслуживает language server и дочерний tsserver (compiled
executable использует `BUN_BE_BUN=1`); внешний Node и workspace TypeScript не нужны.
