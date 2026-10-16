# Разделы MCP и навыков в Settings

[Материалы для участников](../README.md) · [Пользователю: MCP](../../mcp.md) · [Навыки](../../skills.md) · [Архитектурное решение](../../architecture/settings-tools.md)

Реализация относится к Unreleased после 0.6.33. Общая оболочка Settings, её размер, поиск и навигация сохранены. MCP и навыки открываются в области выбранного раздела; команды `/mcp` и `/skills` сохраняют самостоятельные окна. Остальные разделы проверены на отсутствие такого перехода.

## Основания интерфейса

Изучены официальные материалы OpenTUI: [владение фокусом и mouse events](https://opentui.com/docs/core-concepts/interaction/), [Scrollbox](https://opentui.com/docs/components/scrollbox/), [Tab Select](https://opentui.com/docs/components/tab-select/) и [React API](https://opentui.com/docs/api/react/). В проекте закреплён OpenTUI 0.5.12; применённые props сверены с установленными типами, а взаимодействия проверены runtime-fixture. Поиск по Settings не должен конкурировать с вводом секретов в скрытой панели.

В качестве референса разделов использованы официальная [страница настроек VS Code](https://code.visualstudio.com/docs/configure/settings) и её [кадр групп настроек](https://code.visualstudio.com/assets/docs/configure/settings/settings-groups.png): выбранный раздел сохраняет контекст, связанные действия и объяснения находятся рядом. Для отдельного вызова команд сопоставлено поведение [OpenCode TUI](https://opencode.ai/docs/tui/). Эти референсы использованы для содержимого разделов; общая оболочка ChiselCode сохранена по пожеланию владельца.

## Кадры OpenTUI

Кадры получены из настоящего `runOpenTuiAgent` с нативным renderer. MCP в fixture — локальный Streamable HTTP-сервер с настоящими handshake, каталогом tools и записью правил в изолированный config. Для демонстрации ошибки отдельный endpoint отвечает HTTP 418. Пользовательских данных и внешней модели в сценарии нет.

| Сценарий | Obsidian | Paper |
| --- | --- | --- |
| Серверы в Settings | [Кадр](../../assets/settings-tools/obsidian-mcp-list.png) | [Кадр](../../assets/settings-tools/paper-mcp-list.png) |
| Подключённый MCP | [Кадр](../../assets/settings-tools/obsidian-mcp-connected.png) | [Кадр](../../assets/settings-tools/paper-mcp-connected.png) |
| Ошибка подключения | [Кадр](../../assets/settings-tools/obsidian-mcp-error.png) | [Кадр](../../assets/settings-tools/paper-mcp-error.png) |
| Библиотека навыков | [Кадр](../../assets/settings-tools/obsidian-skills-library.png) | [Кадр](../../assets/settings-tools/paper-skills-library.png) |
| Закрепление | [Кадр](../../assets/settings-tools/obsidian-skills-pins.png) | [Кадр](../../assets/settings-tools/paper-skills-pins.png) |
| Инструкции и источник | [Кадр](../../assets/settings-tools/obsidian-skills-instructions.png) | [Кадр](../../assets/settings-tools/paper-skills-instructions.png) |
| Сохранённый MCP-черновик | [Кадр](../../assets/settings-tools/obsidian-mcp-draft-restored.png) | [Кадр](../../assets/settings-tools/paper-mcp-draft-restored.png) |
| 80×24 | [Кадр](../../assets/settings-tools/obsidian-skills-80x24.png) | [Кадр](../../assets/settings-tools/paper-skills-80x24.png) |
| 40×16 | [Кадр](../../assets/settings-tools/obsidian-skills-40x16.png) | [Кадр](../../assets/settings-tools/paper-skills-40x16.png) |
| 24×8 | [Кадр](../../assets/settings-tools/obsidian-skills-24x8.png) | [Кадр](../../assets/settings-tools/paper-skills-24x8.png) |

Рядом сохранены `.txt` и `.json` с символами и цветами renderer. На 24×8 остаются компактный список и клавиатурные действия; подробное управление удобнее при большем размере.

## Проверки

`tests/integration/settings-tools-runtime.test.ts` выполняет production-сценарий в двух темах: одна оболочка для всех разделов, настоящий MCP handshake, ошибка подключения, запись индивидуального разрешения, маска токена, глобальный поиск, закрепление, инструкции, resize, сохранение формы при переходе, защита несохранённых изменений, возвращение черновика и отдельные command dialogs. Просмотр не вызывает MCP tools.

`settings-shell.test.tsx` дополнительно проверяет отмену отложенного выбора навыка после «Остаться» и запрет записи в заменённую generation беседы. Прежние полные тесты MCP и навыков сохраняют покрытие standalone окон и разрешений.

Локально на Linux прошли быстрый профиль (356 тестов), 54 проверки Settings/MCP/навыков и production-fixture в двух темах, 7 проверок оболочки и защиты беседы, TypeScript, lint и CLI/SDK build. После уточнения сохранения учётных данных повторно прошли все 26 тестов MCP/навыков. Lint завершился без ошибок, с существующими warnings/info. Compiled smoke успешно подключил настоящий MCP, прочитал bundled skills и вернул черновик.

Первый compiled-запуск fixture выявил конфликт порядка инициализации Zod при статическом объединении серверного SDK с клиентским runtime. Fixture загружает свой тестовый server SDK динамически, после инициализации приложения; production CLI не импортирует этот dev SDK. Проверка сохранена в CI. Исправление tiny-фона также проверено прежними assertions курсора и черновиков: изменение прозрачности не меняет структуру native inputs.

Первый native run [38915223491](https://github.com/TheAsrada/ChiselCode/actions/runs/38915223491) на `1ac8978` завершился с успешным Linux source (1237 passed, 3 skipped; 1240 тестов в 162 файлах), Linux smoke и macOS smoke (246 passed, 3 skipped; 249 тестов в 33 файлах). Windows нашёл два сбоя: `EPERM` при атомарной замене config во время параллельного чтения и таймаут существующего shell-теста с `EBUSY` при cleanup. Первый сбой исправлен общим ограниченным atomic replace для config/MCP/session; чтение с диска и проверка сохранённого правила в fixture сохранены. Shell-тест, его deadline и assertions не изменены; в итоговом run весь файл прошёл на Windows, сам сценарий занял 1,56 с. Первоначальный таймаут в этом прогоне не воспроизвёлся. Локально после исправления прошли 20 тестов atomic storage, MCP storage и provider config.

Итоговый source: `ec0eada7e84d5278fa61585f717e6ca60373209c`. [Quick CI](https://github.com/TheAsrada/ChiselCode/actions/runs/38916337889) и все четыре job [Native validation](https://github.com/TheAsrada/ChiselCode/actions/runs/38916348393) завершились успешно.

| Проверка | Фактический результат |
| --- | --- |
| Полный source Linux | 1237 passed, 3 skipped, 0 failed; 1240 тестов в 162 файлах |
| macOS ARM64: platform/UI/storage | 246 passed, 3 skipped, 0 failed; 249 тестов в 33 файлах |
| Windows x64: platform/UI/storage | 248 passed, 1 skipped, 0 failed; 249 тестов в 33 файлах; MCP в двух темах и полный shell-файл успешны |
| Installed/compiled Linux, macOS ARM64, Windows x64 | CLI/SDK, настоящий runtime, OpenTUI и новый compiled Settings smoke успешны |
| TypeScript, lint, eval | Успешны; 14/14 eval, lint с warnings/info |

В source полный сценарий проверяется один раз на Linux; Windows/macOS выполняют целиком затронутые test files. Новый compiled smoke ограничен загрузкой UI, bundled skills, MCP handshake и возвратом черновика. Он не повторяет полную матрицу форм и размеров. Документация и ссылки проверены отдельно; опубликованный 0.6.33 не изменён. Физические терминалы, шрифты conhost/SSH и запуск на macOS Intel здесь не проверялись.

Воспроизведение:

```bash
CHISEL_SETTINGS_TOOL_CAPTURES=docs/assets/settings-tools bun test tests/integration/settings-tools-runtime.test.ts
python3 scripts/render-terminal-captures.py docs/assets/settings-tools
```
