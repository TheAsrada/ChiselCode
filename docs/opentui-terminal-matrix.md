# OpenTUI physical terminal checks

Use the `opentui-terminal-<runner>` artifacts from the latest CI run on `main`. The artifacts contain the compiled `chisel` CLI and `opentui-spike` probe for that platform. The probe needs no API key. These checks must run in real terminals; the CI smoke uses an in-memory terminal.

## Windows

Unzip `opentui-terminal-windows-latest`. In **Windows Terminal PowerShell** and then in **classic conhost PowerShell** (select **Windows Console Host** as the default terminal application in Windows settings, then launch `powershell.exe` from Start), run:

```powershell
.\opentui-spike.exe
$env:CHISEL_NO_ALT_SCREEN='1'; .\opentui-spike.exe
Remove-Item Env:CHISEL_NO_ALT_SCREEN
.\chisel.exe
```

For each probe mode, resize through 60×15, 80×24, 120×30 and 160×40; type a multiline paste; open and close context with Ctrl+B/Esc; expand the diff with Ctrl+D; scroll, select and copy Cyrillic text; exit with Ctrl+C. In split-footer, submit a line and verify it enters the terminal's native scrollback above the live editor. After exit, type an ordinary shell command and confirm the cursor, paste, mouse selection and screen behave normally. For `chisel.exe`, use a configured test account, exercise `/settings`, `/sessions`, an approval and a diff; Ctrl+D exits from an empty composer.

## macOS and Linux

Run the matching compiled artifact in macOS Terminal, iTerm2, a Linux terminal and an SSH session. On macOS, use the `opentui-spike-arm64` or `opentui-spike-x64` file matching the machine; on Linux use `opentui-spike`. Give the extracted binary execute permission if needed. Repeat both screen modes and the same size, paste, scroll, selection, approval, diff and cleanup checks. On macOS/Linux the classic mode is `CHISEL_NO_ALT_SCREEN=1 ./opentui-spike`; the agent path is `./chisel`. Also send `SIGTERM` to the running process from another shell and check terminal restoration; this signal check does not apply to Windows.

| Terminal | Alternate screen | Split-footer scrollback | Resize/paste/selection | Ctrl+C / Ctrl+D / SIGTERM cleanup | Agent scenario |
|---|---|---|---|---|---|
| Windows Terminal / PowerShell | pending | pending | pending | pending | pending |
| Windows conhost / PowerShell | pending | pending | pending | pending | pending |
| macOS Terminal | pending | pending | pending | pending | pending |
| iTerm2 | pending | pending | pending | pending | pending |
| Linux terminal | pending | pending | pending | pending | pending |
| SSH terminal | pending | pending | pending | pending | pending |

Record terminal version, OS, artifact SHA, size, outcome and any corrupted frame or leftover terminal mode in the relevant issue or change description. Record defects for the single OpenTUI renderer and fix blocking physical-terminal issues before release.
