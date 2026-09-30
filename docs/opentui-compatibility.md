# OpenTUI compatibility probe

OpenTUI is the sole interactive renderer for `chisel` and `chisel setup`. The probe is a separate diagnostic binary; the regular CLI includes setup, settings, approvals, history and resume.

The regular CLI starts with the Coder Mini logo and a shared multiline composer directly below it. The first submitted task creates a session tab; the adjacent `+`, Alt+N, or Ctrl+Shift+N returns to a fresh start screen without creating an empty tab. Tabs have individual close controls and retain drafts and background replies. Ctrl+S opens the skills library while preserving the current draft.

## Run

Requires Bun 1.3.0 or later; Windows arm64 requires Bun 1.4.0 or later. Dependencies are pinned to `@opentui/core@0.5.12` and `@opentui/react@0.5.12` in `package-lock.json`.

```sh
npm ci
bun run opentui:spike
bun run opentui:compile
./dist/opentui-spike --smoke
```

For a local end-to-end trial, run `bun run src/cli.ts` (or `chisel` from an installer). With no configured key, the developer path opens the protected settings screen before showing the composer; Esc cancels the first run. The path connects the real agent loop, streaming, tool events, approvals, resume, and current Git changes to the OpenTUI shell. Ctrl+C or SIGTERM aborts the active request before terminal teardown. `/sessions` and `/resume` open a searchable session picker with preview, rename, delete confirmation and resume; `/settings` and `/model` open a settings popup over the mounted conversation, with searchable providers/models/profiles, a masked native key buffer, connection check and save. Its Appearance section previews and saves themes; Ctrl+T opens that section, and Ctrl+, opens settings where supported. Escape cancels an unsaved preview and restores composer focus and cursor. Slow model lookup allows manual entry, and late responses after cancellation are ignored. `/skills` opens a searchable library popup over the conversation: Enter prepares `/имя` in the composer, preserves the task draft, and waits for submission. Tab opens separate pinning controls for subsequent requests in the current tab. Ctrl+O shows instructions; Ctrl+N prepares creation and Ctrl+E prepares editing a user skill through `/skill-creator`. `/resume <id>`, `/help`, `/clear`, `/cwd <path>`, `/status`, `/doctor`, `/update`, and `/exit` also work. The composer keeps sent prompt history with ↑/↓ at line boundaries and Ctrl+P/Ctrl+N, restoring an unsent draft on return. Built-in slash prefixes and invocable skills show keyboard suggestions in the composer; Tab or Enter accepts a prefix. `chisel setup` uses the protected OpenTUI settings screen and exits after saving or cancelling.

The probe exercises a React root, a sticky culling scrollbox, a multiline textarea, a single-file diff, resize, sidebar overlay, keyboard focus, and cleanup. Ctrl+B opens the context overlay, Ctrl+D expands the diff in the probe, Tab cycles composer/transcript/inline sidebar, Esc restores composer focus or closes an overlay, and Ctrl+C exits. `CHISEL_ALT_SCREEN=0` or `CHISEL_NO_ALT_SCREEN=1` selects `split-footer` for the probe; default is alternate screen.

The controller-backed probe now renders a bounded 240-entry transcript window. PgUp/PgDn and the mouse wheel at the viewport boundary move by 120 entries; End returns to the latest entries. File changes show up to five changed lines and expand one diff on Ctrl+D, using a split view only when the available diff width reaches 100 columns. Terminal control sequences are removed from rendered transcript text. In a local Node 26/Linux x64 in-memory native render of 10,000 short entries, initial frame preparation took about 60 ms and PgUp about 28 ms. For 10,000 short items in split-footer, batching 64 entries per native commit took about 709 ms for replay on the same machine (157 commits). These local measurements are not physical-terminal latency benchmarks. The compiled Bun 1.4.2 in-memory smoke from CI run 36511920353 measured the same 10,000-entry replay:

| Runner | Replay | Commits |
|---|---:|---:|
| Linux x64 glibc | 679 ms | 157 |
| macOS runner | 948 ms | 157 |
| Windows x64 | 893 ms | 157 |

These measurements do not exercise input latency or terminal scrollback in a physical console.

The optional approval resolver now binds to a full-screen decision view. An outstanding action takes keyboard priority, displays a scrollable sanitized preview or native file diff, and accepts `y`/`н`, `n`/`т`, or Esc. The composer returns after a decision. The OpenTUI shell owns the agent approval flow.

`--smoke` is an in-memory native renderer test for the **compiled artifact**. CI builds it and runs this smoke on Linux x64 glibc, macOS and Windows x64; it also installs the packed npm tarball, builds the regular CLI, and checks `--version` and `doctor` for both installed and compiled forms. These checks verify native dependency loading, frame rendering, resize, split-footer scrollback commits, and teardown without claiming real-terminal compatibility.

## Physical terminal checks

Use [the physical terminal matrix](opentui-terminal-matrix.md) and the compiled CI artifacts to check PowerShell/Windows Terminal, conhost, macOS Terminal/iTerm2, Linux and SSH. Confirm Ctrl+C/Ctrl+D/SIGTERM, paste, mouse selection, resize, cursor/raw-mode restoration, scrollback and install paths. In-memory smoke does not prove physical TTY compatibility. The release workflow builds Windows x64, macOS x64/arm64 and Linux x64 glibc, then publishes only when all four assets upload successfully. Musl is not published.

Provider settings use the registry catalog, searchable/windowed selectors and independent profiles. /settings can create or switch profiles; historical tabs keep their saved profile unless explicitly edited. Custom manifests are declarative and loaded on startup.
