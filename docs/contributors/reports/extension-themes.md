# Проверка тем расширений

[Отчёты](../README.md) · [Архитектура](../../architecture/themes.md) · [Пользовательская справка](../../themes.md) · [SDK](../../extensions/themes.md)

Изменения и проверки выполняются прямо в main. Roadmap не изменён. Выпуск 0.6.26 ещё не опубликован; результаты CI и финальный source будут заполнены после фактического завершения.

## Реальные сценарии

Отдельный `fixture.themes` объявляет «Север» и «Лён». Авторский TS копируется вне checkout и собирается в `.mjs`; package появляется в canonical Home после сборки harness, проходит inspect/exact trust и ordinary loader. Fixture не добавлен в defaults или payload распространения.

`tests/fixtures/tui-extension-themes.ts` запускает ordinary `runOpenTuiAgent`: реальные dark/light палитры из captureSpans, поиск, применение, отмена, config persistence, сохранённый accent, editor instance/draft/focus, повторный запуск и удалённый package с fallback. Browse/select не вызывают network/model. `command-packaging.ts` проверяет этот сценарий в установленном npm bundle и compiled binary. `external-extensions-cli.ts` typechecks отдельного автора двух тем по declarations установленного SDK.

Исходник автора исключён из TS-программы приложения: он отдельно typechecks вне checkout по declarations реального npm package. Первый чистый CI `38395926527` выявил зависимость этого fixture от локального `dist`; граница исправлена, проверка автора в distribution smoke сохранена.

Unit scenarios проверяют полноту/schema/contrast, immutable namespace, invalid-theme isolation, accent override, старые настройки и app catalog после workspace close. Production background fixture дополнительно меняет тему при живом процессе и удержанном model response: spawn остаётся один, model requests не прибавляются, retained output и selected stop продолжают работать. Существующие process/task suites сохраняются.

## Кадры OpenTUI

Папки [ASCII](../../assets/extension-themes/ascii/) и [Unicode](../../assets/extension-themes/unicode/) содержат captureCharFrame TXT, captureSpans JSON и экспортированные PNG. Размеры каталога: 160×50, 80×24, 40×12, 24×8; интерфейса: 160×50, 40×12, 24×8. Есть повторный startup и unavailable fallback. PNG строятся из реальных spans, не browser/imagegen mockups.

При первом визуальном просмотре обнаружен скрытый selected row и обрезанная отмена на маленьких экранах. Расчёт windowed list и компактные подписи исправлены; regression проверяет visible selection после каждого resize. Финальная пересъёмка показывает выбранную строку и обе actions на всех размерах. PNG вручную просмотрены: светлый и тёмный interface/catalog, ASCII/Unicode, широкий 160×50, 80×24, 40×12 и 24×8. Кадры намеренно сохраняют пользовательский accent override из fixture.

## Regression текущей базы

CI `38388017094`, Windows Quality: promotion fixture ожидал «Сохранённая строка» в live tail после серии capture/resize. В журнале viewer показывал реальные «Новая строка», поэтому ожидание tail ошибочно требовало ранние строки. Fixture теперь принимает реальный initial/live output, сравнивает замороженные строки обоих видов и сохраняет отдельный поиск раннего retained output. Assertion результата/cleanup не снят; runtime stop/ownership не изменён. Проверка Windows будет отражена по новому CI.

## Проверки и ограничения

Локальный Linux: полный `bun test` — 1169 pass / 3 skip / 0 fail, 1172 теста в 141 файле, 10936 assertions, 224.54 с. Пропуски: native OS clipboard и два Windows CMD/Python сценария. Typecheck/build и полный installed/compiled command-packaging smoke прошли. Lint — 0 errors, 226 warnings / 29 infos существующих и проверенных правил; eval — 14/14 assertions в четырёх сценариях. Native promotion одного shell instance со сменой темы прошла отдельно. Windows/macOS/Linux CI будут уточнены по финальному source; локальный Linux не является доказательством остальных ОС.
