# Кадры визуальной системы

[Исследование и реализация](../../contributors/reports/interface-design.md) · [Документация](../../README.md)

`*-before-home-*` сняты обычным `runOpenTuiAgent` до изменений, source `f6a04c767f9b16991e7d225a23109f38f8d2580a`, CLI 0.6.40. Остальные кадры сняты production fixture `tests/fixtures/tui-ui-design.ts`: приложение, native renderer и настоящий SDK с локальным endpoint. Настройки, Git-папки и ключи тестовые; пользовательские разговоры не используются.

Каждому статическому PNG соответствуют исходный TXT и JSON spans. `obsidian-motion-00…15.json` содержат последовательные native кадры и `capturedAtMs`; GIF построен из этих данных. Имя фиктивной модели отличается от исходной конфигурации; снимки не сравнивают производительность.

Воспроизведение из корня репозитория:

```sh
CHISEL_DESIGN_CAPTURES=dist/ui-design-captures bun tests/fixtures/tui-ui-design.ts
CHISEL_DESIGN_THEME=paper CHISEL_DESIGN_CAPTURES=dist/ui-design-captures bun tests/fixtures/tui-ui-design.ts
python scripts/render-terminal-captures.py dist/ui-design-captures
python scripts/render-terminal-animation.py dist/ui-design-captures obsidian-motion- dist/ui-design-captures/obsidian-motion.gif
```

Экспорт использует Pillow и системные DejaVu Sans Mono/Noto Sans CJK. Исходные символы и цвета берутся из renderer; PNG/GIF зависят от доступных glyphs экспортного шрифта.
