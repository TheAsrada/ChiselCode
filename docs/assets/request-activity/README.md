# Кадры искры активного запроса

[Отчёт и проверки](../../contributors/reports/request-activity.md) · [Документация](../../README.md)

Снято 25 октября 2026 года на Linux/Bun 1.4.4, OpenTUI 0.5.12. Это настоящий `runOpenTuiAgent`, SDK и native `captureSpans`; локальный endpoint задаёт последовательность действий, инструменты действительно читают, ищут, записывают файл и запускают shell после подтверждения. Пользовательских данных нет.

`obsidian-reading` и `paper-editing` сохраняют полный viewport 120×36 в JSON, TXT и PNG. `*-journey-00..21.json` — точные вырезки native области `request-status` шириной 44 клетки. `sourceRegion` указывает исходное имя кадра и координаты; цвета, текст и `capturedAtMs` сохранены. GIF собраны из этих JSON с интервалами capture, ограниченными существующим экспортёром до 30–1000 мс. Шрифт PNG/GIF принадлежит экспортёру; физический терминал использует свой шрифт.

Воспроизведение из корня репозитория:

```bash
CHISEL_DESIGN_CAPTURES=dist/spark-captures bun tests/fixtures/tui-ui-design.ts
CHISEL_DESIGN_THEME=paper CHISEL_DESIGN_CAPTURES=dist/spark-captures bun tests/fixtures/tui-ui-design.ts
python scripts/crop-terminal-status.py dist/spark-captures dist/spark-status obsidian-journey-
python scripts/crop-terminal-status.py dist/spark-captures dist/spark-status paper-journey-
python scripts/render-terminal-animation.py dist/spark-status obsidian-journey- dist/spark-status/obsidian-spark.gif
python scripts/render-terminal-animation.py dist/spark-status paper-journey- dist/spark-status/paper-spark.gif
python scripts/render-terminal-captures.py dist/spark-captures
```

Для экспорта нужны Python, Pillow, DejaVu Sans Mono/Sans и Noto Sans CJK. Для Braille используется Sans: в Mono этих глифов нет. Повторный экспорт сохранённых строк выполняется без запуска приложения:

```bash
python scripts/render-terminal-animation.py docs/assets/request-activity obsidian-journey- dist/obsidian-spark.gif
python scripts/render-terminal-animation.py docs/assets/request-activity paper-journey- dist/paper-spark.gif
```
