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

The probe exercises a React root, a sticky culling scrollbox, a multiline textarea, a single-file diff, resize, sidebar overlay, keyboard focus, and cleanup. Ctrl+B opens the context overlay, Ctrl+D expands the diff, Tab changes focus, Esc closes an overlay or exits, Ctrl+C exits. `CHISEL_ALT_SCREEN=0` or `CHISEL_NO_ALT_SCREEN=1` selects `split-footer` for the probe; default is alternate screen.

`--smoke` is an in-memory native renderer test for the **compiled artifact**. CI builds it and runs this smoke on Linux x64 glibc, macOS and Windows x64; it also builds the regular CLI and checks `--version` and `doctor`. These checks verify native dependency loading, frame rendering, resize, and teardown without claiming real-terminal compatibility.

## Remaining release gates

- Exercise an actual TTY, Ctrl+C/Ctrl+D/SIGTERM, paste, mouse selection, and cursor/raw-mode restoration on PowerShell/Windows Terminal, conhost, macOS Terminal/iTerm2, Linux, and SSH. In particular, verify the Windows compiled interactive binary before selecting OpenTUI by default.
- Implement a scrollback commit policy for `split-footer`. It preserves a real main-screen scrollback surface only for content explicitly committed above the footer. The probe does not yet commit transcript items; it cannot substitute for the old classic mode.
- Migrate the application controller and all modal surfaces, approvals, setup key masking, session history, slash commands, usage snapshots, current Git changes, and diff navigation. Keep the old renderer until parity is measured.
- Cross-compile release targets with their matching `@opentui/core-*` optional packages installed. The release workflow currently builds Windows x64, macOS x64/arm64, and Linux x64 glibc. It does not publish musl.
- Measure 10,000 transcript entries and document interactive latency, viewport behavior, and the manual terminal matrix in the migration PR.

The `--smoke` check does not exercise `createCliRenderer()` against a physical terminal. Do not tag a user release on the strength of this probe alone.
