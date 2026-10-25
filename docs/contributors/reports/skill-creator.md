# Первичная проверка создания навыков

[Материалы для участников](../README.md) · [Текущие команды проверки](../feature-checks.md#проверка-создания-навыков) · [Пользовательская библиотека](../../skills.md)

Это исторический результат этапа реализации, а не проверка каждого последующего коммита.

Первичная проверка skill-creator на source `cd41869` выполнена локально на Linux: 356 быстрых тестов, 53 профильных unit/UI-теста, два integration-сценария, typecheck/lint/build; полный creator UI-сценарий прошёл из исходников, JS bundle установленного npm-пакета и compiled fixture. Проверка упаковки входит в integration-файл: настоящий `npm pack --dry-run` и загрузка обоих навыков из bundle в изолированном `node_modules/chiselcode`. Кадр [OpenTUI](../../assets/skill-creator/skill-creator.png) получен через production renderer, TXT/JSON сохранены рядом. В этой первичной проверке Windows/macOS не запускались; более поздние проверки общего source и поставки описаны в [отчёте UI-композиции](ui-composition.md).
