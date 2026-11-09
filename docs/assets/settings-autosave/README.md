# Кадры автосохранения Settings

[Документация](../../README.md) · [Архитектура](../../architecture/settings-autosave.md)

Кадры получены из настоящего OpenTUI на Linux через `testRender` и `captureSpans`, затем экспортированы штатным `scripts/render-terminal-captures.py`. Во время задержанной записи пользователь дописывает новое название; resize сохраняет native input и курсор. JSON содержит исходные spans, TXT — текст терминала, PNG — их визуализацию.

- [120×40](connections-120x40.png)
- [80×24](connections-80x24.png)
- [40×16](connections-40x16.png)
- [24×8](connections-24x8.png)

Воспроизведение:

```bash
CHISEL_AUTOSAVE_CAPTURES=docs/assets/settings-autosave bun test tests/unit/settings-autosave-runtime.test.tsx
python scripts/render-terminal-captures.py docs/assets/settings-autosave
```
