# Кадры навигации меню

[Отчёт реализации](../../contributors/reports/menu-keybindings.md) · [Документация](../../README.md)

Настоящий OpenTUI renderer с демонстрационными данными. `before-*` относится к source `977c4a4` (0.6.48), `after-*` — к реализации навигации для 0.6.49. Для каждого из четырёх окон сохранены 120×40, 80×24, 60×15 и 32×10; рядом с PNG лежат TXT и native spans JSON. Это воспроизводимые кадры renderer, без проверки конкретного физического терминала.

```powershell
bun tests/fixtures/menu-captures.tsx docs/assets/menu-keybindings after
python scripts/render-terminal-captures.py docs/assets/menu-keybindings
```

Fixture не читает пользовательские ключи или историю и не запускает модель. Для сравнения «до» использовались исходники четырёх окон из указанного базового коммита.
