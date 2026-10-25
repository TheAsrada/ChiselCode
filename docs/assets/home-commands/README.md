# Главная после команд

[Отчёт и проверки](../../contributors/reports/home-commands.md) · [Документация](../../README.md)

Кадры сняты расширенным `tests/fixtures/tui-ui-design.ts` через обычный `runOpenTuiAgent`, native renderer и настоящий SDK с локальным endpoint. Папки и профиль тестовые. PNG экспортированы из `captureSpans`; TXT и JSON сохранены рядом. В папке намеренно нет Git, чтобы проверить ошибку менеджера без изменения пользовательских репозиториев.

```sh
CHISEL_DESIGN_CAPTURES=dist/home-command-captures bun tests/fixtures/tui-ui-design.ts
python scripts/render-terminal-captures.py dist/home-command-captures
```

Выбраны кадры `command-error-120x36`, `command-error-24x8`, `worktree-error-120x36` и `home-after-commands-120x36`. Экспорт использует Pillow и установленные системные шрифты; это реальные состояния интерфейса, а не макеты.
