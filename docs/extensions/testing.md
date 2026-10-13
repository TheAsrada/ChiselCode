# Проверки и диагностика

[Разработка расширений](README.md) · [Формат пакета](package.md) · [Пользовательское восстановление](../extensions.md#запуск-статусы-и-восстановление)

Проверяйте package в отдельном TypeScript-проекте с установленным packed ChiselCode. Declarations должны разрешаться через `chiselcode/extension-sdk`; готовый `.mjs` не должен импортировать внутренний `src` или требовать bare runtime SDK.

Затем используйте ordinary CLI inspect/install/approve/status и новый запуск приложения. [Папка и ZIP](package-management.md) должны устанавливаться из внешнего source; удалите его и убедитесь, что installed package самостоятелен. Проверки distribution копируют entry после compilation; injected definition не доказывает внешний loader. Project config не выдаёт trust. Для tools проверьте реальные files/checkpoints, Plan, deny, адресованные approvals, stale revisions и workspace conflicts.

Для отдельного author project с packed SDK: bun node_modules/typescript/bin/tsc --noEmit --project tsconfig.json, затем bun build index.ts --target bun --outfile package/index.mjs. Manifest и assets помещаются в package отдельно; проверяйте assembled package, а не source node_modules. Репозиторный tests/fixtures/extension-packages-cli.ts использует declarations установленного tarball и ordinary npm/compiled CLI с настоящим author output.

| Состояние | Значение |
| --- | --- |
| disabled | User/project отключил пакет; code import не нужен |
| not_trusted | Для проверенного содержимого нет совпадающего доверия |
| incompatible | Версия приложения/платформа не подходят |
| modified | Digest/location не совпадают с receipt |
| invalid | Manifest/paths/limits не прошли проверку |
| loading | Разрешённая загрузка ещё выполняется |
| active | Workspace успешно sealed |
| load_failed | Import/factory отказал после trust |
| activation_failed | Frame activation откатился |
| cleanup_failed | Registrations сняты; resource cleanup не подтверждён |
| pending_restart | Сохранён enabled выбор; изменения применяются новым запуском |

Standalone `chisel extensions status` пассивен и не сообщает active за другой процесс. Cached workspace metadata доступна core для дальнейшего управления; Settings → Extensions ещё не выпускается.

Import/factory/activation waits cooperative и bounded 10 секундами; synchronous endless callback или `process.exit` может остановить весь процесс. Не тестируйте такой код в основном test runner. Используйте отдельный процесс с конечным timeout и recovery flag. Нет CPU/RAM/OS isolation для недоверенного JS.

Проектные proofs и native capture paths записываются в [отчёте](../contributors/reports/external-extension-loader.md). Они относятся к указанному source/CI, не автоматически к каждому следующему commit.
