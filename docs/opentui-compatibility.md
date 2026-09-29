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

For a local end-to-end trial, run `CHISEL_OPENTUI_DEV=1 bun run src/cli.ts` (PowerShell: `$env:CHISEL_OPENTUI_DEV='1'; bun run src/cli.ts`). With no configured key, the developer path opens the protected settings screen before showing the composer; Esc cancels the first run. The path connects the real agent loop, streaming, tool events, approvals, resume, and current Git changes to the OpenTUI shell. Ctrl+C or SIGTERM aborts the active request before terminal teardown. `/sessions` and `/resume` open a searchable session picker with preview, rename, delete confirmation and resume; `/settings` and `/model` open a keyboard-operated settings screen with a masked key field, model lookup, connection check and save. `/skills` opens a panel to inspect and activate skills, while `/имя` invokes an available skill once; active skill instructions are attached to subsequent requests. `/resume <id>`, `/help`, `/clear`, `/cwd <path>`, `/status`, `/doctor`, `/update`, and `/exit` also work. The composer keeps sent prompt history with ↑/↓ at line boundaries and Ctrl+P/Ctrl+N, restoring an unsent draft on return. Built-in slash prefixes and invocable skills show keyboard suggestions in the composer; Tab or Enter accepts a prefix. With the same developer flag, `chisel setup` uses the protected OpenTUI settings screen and exits after saving or cancelling. The developer flag is not a user-facing default.

The probe exercises a React root, a sticky culling scrollbox, a multiline textarea, a single-file diff, resize, sidebar overlay, keyboard focus, and cleanup. Ctrl+B opens the context overlay, Ctrl+D expands the diff, Tab changes focus, Esc closes an overlay or exits, Ctrl+C exits. `CHISEL_ALT_SCREEN=0` or `CHISEL_NO_ALT_SCREEN=1` selects `split-footer` for the probe; default is alternate screen.

The controller-backed probe now renders a bounded 240-entry transcript window. PgUp/PgDn and the mouse wheel at the viewport boundary move by 120 entries; End returns to the latest entries. File changes show up to five changed lines and expand one diff on Ctrl+D, using a split view only when the available diff width reaches 100 columns. Terminal control sequences are removed from rendered transcript text. In a local Node 26/Linux x64 in-memory native render of 10,000 short entries, initial frame preparation took about 60 ms and PgUp about 28 ms. For 10,000 short items in split-footer, batching 64 entries per native commit took about 709 ms for replay on the same machine (157 commits). These local measurements are not physical-terminal latency benchmarks. The compiled Bun 1.4.2 in-memory smoke from CI run 36511920353 measured the same 10,000-entry replay:

| Runner | Replay | Commits |
|---|---:|---:|
| Linux x64 glibc | 679 ms | 157 |
| macOS runner | 948 ms | 157 |
| Windows x64 | 893 ms | 157 |

These measurements do not exercise input latency or terminal scrollback in a physical console.

The optional approval resolver now binds to a full-screen decision view. An outstanding action takes keyboard priority, displays a scrollable sanitized preview or native file diff, and accepts `y`/`н`, `n`/`т`, or Esc. The composer returns after a decision. The regular CLI still owns agent approval flow until the OpenTUI shell is wired to the full application.

`--smoke` is an in-memory native renderer test for the **compiled artifact**. CI builds it and runs this smoke on Linux x64 glibc, macOS and Windows x64; it also installs the packed npm tarball, builds the regular CLI, and checks `--version` and `doctor` for both installed and compiled forms. These checks verify native dependency loading, frame rendering, resize, split-footer scrollback commits, and teardown without claiming real-terminal compatibility.

## Remaining release gates

Use [the physical terminal matrix](opentui-terminal-matrix.md) and the compiled CI artifacts for the manual checks below.

- Exercise an actual TTY, Ctrl+C/Ctrl+D/SIGTERM, paste, mouse selection, and cursor/raw-mode restoration on PowerShell/Windows Terminal, conhost, macOS Terminal/iTerm2, Linux, and SSH. In particular, verify the Windows compiled interactive binary before selecting OpenTUI by default.
- Validate the `split-footer` scrollback policy in physical terminals: completed transcript entries are committed above the live footer, and switching sessions resets the visible history. The in-memory native smoke verifies commits but cannot verify terminal scrollback controls or restoration.
- Migrate the application controller and all modal surfaces, approvals, setup key masking, session history, slash commands, usage snapshots, current Git changes, and diff navigation. Keep the old renderer until parity is measured.
- Validate cross-compiled release targets with their matching `@opentui/core-*` optional packages installed. CI and the release workflow now install both macOS x64/arm64 packages explicitly. The release workflow builds Windows x64, macOS x64/arm64, and Linux x64 glibc. It does not publish musl. The release workflow stages all four installers as CI artifacts, creates a draft release only after every build succeeds, and publishes it after all four assets are uploaded.
- Measure 10,000 transcript entries on each compiled target and document interactive latency, viewport behavior, and the manual terminal matrix in the migration PR.

The `--smoke` check does not exercise `createCliRenderer()` against a physical terminal. Do not tag a user release on the strength of this probe alone.
