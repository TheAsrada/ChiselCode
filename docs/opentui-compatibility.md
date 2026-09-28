# OpenTUI compatibility probe

This is the first, isolated stage of the renderer migration. The regular `chisel` command still uses Ink until the interactive parity checks pass. The probe is deliberately not shipped as a replacement for setup, settings, approvals, history, or resume.

## Run

Requires Bun 1.3.0 or later; Windows arm64 requires Bun 1.4.0 or later. Dependencies are pinned to `@opentui/core@0.5.12` and `@opentui/react@0.5.12` in `package-lock.json`.

```sh
npm ci
bun run opentui:spike
bun run opentui:compile
./dist/opentui-spike --smoke
```

For a local end-to-end trial with an already configured provider, run `CHISEL_OPENTUI_DEV=1 bun run src/cli.ts` (PowerShell: `$env:CHISEL_OPENTUI_DEV='1'; bun run src/cli.ts`). This developer path connects the real agent loop, streaming, tool events, approvals, resume, and current Git changes to the OpenTUI shell. Ctrl+C or SIGTERM aborts the active request before terminal teardown. `/sessions` and `/resume` open a searchable session picker with preview, rename, delete confirmation and resume; `/resume <id>`, `/help`, `/clear`, `/cwd <path>`, and `/exit` also work. Other slash commands still require the regular CLI; the developer flag is not a user-facing default.

The probe exercises a React root, a sticky culling scrollbox, a multiline textarea, a single-file diff, resize, sidebar overlay, keyboard focus, and cleanup. Ctrl+B opens the context overlay, Ctrl+D expands the diff, Tab changes focus, Esc closes an overlay or exits, Ctrl+C exits. `CHISEL_ALT_SCREEN=0` or `CHISEL_NO_ALT_SCREEN=1` selects `split-footer` for the probe; default is alternate screen.

The controller-backed probe now renders a bounded 240-entry transcript window. PgUp/PgDn and the mouse wheel at the viewport boundary move by 120 entries; End returns to the latest entries. File changes show up to five changed lines and expand one diff on Ctrl+D, using a split view only when the available diff width reaches 100 columns. Terminal control sequences are removed from rendered transcript text. In a local Node 26/Linux x64 in-memory native render of 10,000 short entries, initial frame preparation took about 60 ms and PgUp about 28 ms. These are development measurements, not compiled Bun or physical-terminal latency benchmarks.

The optional approval resolver now binds to a full-screen decision view. An outstanding action takes keyboard priority, displays a scrollable sanitized preview or native file diff, and accepts `y`/`н`, `n`/`т`, or Esc. The composer returns after a decision. The regular CLI still owns agent approval flow until the OpenTUI shell is wired to the full application.

`--smoke` is an in-memory native renderer test for the **compiled artifact**. CI builds it and runs this smoke on Linux x64 glibc, macOS and Windows x64; it also builds the regular CLI and checks `--version` and `doctor`. These checks verify native dependency loading, frame rendering, resize, and teardown without claiming real-terminal compatibility.

## Remaining release gates

- Exercise an actual TTY, Ctrl+C/Ctrl+D/SIGTERM, paste, mouse selection, and cursor/raw-mode restoration on PowerShell/Windows Terminal, conhost, macOS Terminal/iTerm2, Linux, and SSH. In particular, verify the Windows compiled interactive binary before selecting OpenTUI by default.
- Implement a scrollback commit policy for `split-footer`. It preserves a real main-screen scrollback surface only for content explicitly committed above the footer. The probe does not yet commit transcript items; it cannot substitute for the old classic mode.
- Migrate the application controller and all modal surfaces, approvals, setup key masking, session history, slash commands, usage snapshots, current Git changes, and diff navigation. Keep the old renderer until parity is measured.
- Cross-compile release targets with their matching `@opentui/core-*` optional packages installed. The release workflow currently builds Windows x64, macOS x64/arm64, and Linux x64 glibc. It does not publish musl.
- Measure 10,000 transcript entries on each compiled target and document interactive latency, viewport behavior, and the manual terminal matrix in the migration PR.

The `--smoke` check does not exercise `createCliRenderer()` against a physical terminal. Do not tag a user release on the strength of this probe alone.
