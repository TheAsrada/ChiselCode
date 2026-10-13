# Проверка тем расширений

[Отчёты](../README.md) · [Архитектура](../../architecture/themes.md) · [Пользовательская справка](../../themes.md) · [SDK](../../extensions/themes.md)

Изменения и проверки выполнены прямо в main. Roadmap не изменён. Runtime source/tag `v0.6.26`: `d8da4ca3061d343c31e5f09d528adb43f6c02035`. [Source CI 38396214104](https://github.com/TheAsrada/ChiselCode/actions/runs/38396214104) завершён success: все шесть Quality / Real Auto LSP jobs Windows/macOS/Linux. Выпуск [0.6.26](https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.26) опубликован 13.10.2026 в 12:56:08 UTC. [Release 38400115956](https://github.com/TheAsrada/ChiselCode/actions/runs/38400115956) завершён success: verify, SDK, установщики Windows/macOS/Linux и publish. Все пять assets имеют состояние uploaded; draft=false, prerelease=false.

## Реальные сценарии

Отдельный `fixture.themes` объявляет «Север» и «Лён». Авторский TS копируется вне checkout и собирается в `.mjs`; package появляется в canonical Home после сборки harness, проходит inspect/exact trust и ordinary loader. Fixture не добавлен в defaults или payload распространения.

`tests/fixtures/tui-extension-themes.ts` запускает ordinary `runOpenTuiAgent`: реальные dark/light палитры из captureSpans, поиск, применение, отмена, config persistence, сохранённый accent, editor instance/draft/focus, повторный запуск и удалённый package с fallback. Browse/select не вызывают network/model. `command-packaging.ts` проверяет этот сценарий в установленном npm bundle и compiled binary. `external-extensions-cli.ts` typechecks отдельного автора двух тем по declarations установленного SDK.

Исходник автора исключён из TS-программы приложения: он отдельно typechecks вне checkout по declarations реального npm package. Первый чистый CI `38395926527` выявил зависимость этого fixture от локального `dist`; граница исправлена, проверка автора в distribution smoke сохранена.

Unit scenarios проверяют полноту/schema/contrast, immutable namespace, invalid-theme isolation, accent override, старые настройки и app catalog после workspace close. Production background fixture дополнительно меняет тему при живом процессе и удержанном model response: spawn остаётся один, model requests не прибавляются, retained output и selected stop продолжают работать. Существующие process/task suites сохраняются.

## Кадры OpenTUI

Сохранены 32 набора TXT/JSON/PNG. Папки [ASCII](../../assets/extension-themes/ascii/) и [Unicode](../../assets/extension-themes/unicode/) содержат captureCharFrame TXT, captureSpans JSON и экспортированные PNG. Размеры каталога: 160×50, 80×24, 40×12, 24×8; интерфейса: 160×50, 40×12, 24×8. Есть повторный startup и unavailable fallback. PNG строятся из реальных spans, не browser/imagegen mockups.

При первом визуальном просмотре обнаружен скрытый selected row и обрезанная отмена на маленьких экранах. Расчёт windowed list и компактные подписи исправлены; regression проверяет visible selection после каждого resize. Финальная пересъёмка показывает выбранную строку и обе actions на всех размерах. PNG вручную просмотрены: светлый и тёмный interface/catalog, ASCII/Unicode, широкий 160×50, 80×24, 40×12 и 24×8. Кадры намеренно сохраняют пользовательский accent override из fixture.

## Regression текущей базы

CI `38388017094`, Windows Quality: promotion fixture ожидал «Сохранённая строка» в live tail после серии capture/resize. В журнале viewer показывал реальные «Новая строка», поэтому ожидание tail ошибочно требовало ранние строки. Fixture теперь принимает реальный initial/live output, сравнивает замороженные строки обоих видов и сохраняет отдельный поиск раннего retained output. Assertion результата/cleanup не снят; runtime stop/ownership не изменён. Windows Quality нового source прошёл regression дважды: ранний compiled/native smoke и полный suite; promotion — 6605.77 и 6570.13 мс, без нового spawn.

## Проверки и ограничения

Локальный Linux: полный `bun test` — 1169 pass / 3 skip / 0 fail, 1172 теста в 141 файле, 10936 assertions, 201.83 с. Пропуски: native OS clipboard и два Windows CMD/Python сценария. Typecheck/build и полный installed/compiled command-packaging smoke прошли. Lint — 0 errors, 226 warnings / 29 infos существующих и проверенных правил; eval — 14/14 assertions в четырёх сценариях. Native promotion одного shell instance со сменой темы прошла отдельно. Межплатформенные результаты подтверждены собственными jobs CI:

| Платформа | Полный suite | Время | Распространение |
| --- | --- | --- | --- |
| Linux | 1169 pass / 3 skip / 0 fail | 210.20 с | npm/compiled themes, SDK и native TUI success |
| macOS | 1169 pass / 3 skip / 0 fail | 328.92 с | npm/compiled themes, SDK и native TUI success |
| Windows | 1170 pass / 2 skip / 0 fail | 668.10 с | npm/compiled themes, SDK и native TUI success |

Native OS clipboard проверка недоступна в локальной headless среде. Изменения кода/доверия/включения пакета требуют restart; темы не обещают hot unload trusted in-process JS. Проверяется исходная палитра, пользовательский accent override применяется отдельно и сохраняется.

## Файлы опубликованного выпуска

- `chiselcode-0.6.26.tgz` — 5732190 bytes; `sha256:1a63c4403bf00e8509c0a8b82fb20d609af5c300200214a2e17e76f07d7c0a86`.
- `ChiselCode-Setup-0.6.26-linux-amd64.deb` — 36905932 bytes; `sha256:78fc747646a2356808b0bc95137c9bdcdb4876ddb48f39220d41d0ba665b6d6a`.
- `ChiselCode-Setup-0.6.26-macos-arm64.pkg` — 33234450 bytes; `sha256:d3b84daff41417ed59fa0c5f885ad80d289aee1aefffe34e22599e8f4c6dd8ef`.
- `ChiselCode-Setup-0.6.26-macos-x64.pkg` — 35826603 bytes; `sha256:941e49f8583ea4ee89943210118977e7f7ac7150ebed61b32cb3c464352dabde`.
- `ChiselCode-Setup-0.6.26.exe` — 38647461 bytes; `sha256:f90e11b8e7d0735822b801153b0559fd6aa9f5b549325bdbd186e954e4f17bd2`.

Source/tag неизменны; последующий commit обновляет только сведения документации. Его CI нельзя считать завершённым по результатам release source.
