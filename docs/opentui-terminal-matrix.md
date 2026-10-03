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

For each probe mode, resize through 60×15, 80×24, 120×30 and 160×40. Paste Cyrillic, emoji and multiline Windows text with Ctrl+V, Ctrl+Shift+V, Shift+Insert and right-click; verify text stays in the draft. Select chat text with the mouse and paste it elsewhere; repeat with Ctrl+Shift+C and Ctrl+Insert. Select draft text, then paste to replace it without changing the incoming clipboard. Right-click the send button and mode controls: neither must activate. Open and close context with Ctrl+B/Esc; expand the diff with Ctrl+D; exit with `/exit`. In split-footer, submit a line and verify it enters the terminal's native scrollback above the live editor. After exit, type an ordinary shell command and confirm the cursor, paste, mouse selection and screen behave normally. For `chisel.exe`, use a configured test account, exercise `/settings`, `/sessions`, an approval and a diff. Paste into a masked credential field and verify the secret never appears in the terminal. Start requests in two tabs, switch during an approval, and verify Ctrl+C stops only the selected tab and its queued follow-ups. Ctrl+D and Escape must leave the application open.

## macOS and Linux

Run the matching compiled artifact in macOS Terminal, iTerm2, a Linux terminal and an SSH session. On macOS, use the `opentui-spike-arm64` or `opentui-spike-x64` file matching the machine; on Linux use `opentui-spike`. Give the extracted binary execute permission if needed. Repeat both screen modes and the same size, paste, scroll, selection, approval, diff and cleanup checks. On macOS/Linux the classic mode is `CHISEL_NO_ALT_SCREEN=1 ./opentui-spike`; the agent path is `./chisel`. Also send `SIGTERM` to the running process from another shell and check terminal restoration; this signal check does not apply to Windows.

| Terminal | Alternate screen | Split-footer scrollback | Resize/paste/selection | /exit / SIGTERM cleanup | Agent scenario |
|---|---|---|---|---|---|
| Windows Terminal / PowerShell | pending | pending | pending | pending | pending |
| Windows conhost / PowerShell | pending | pending | pending | pending | pending |
| macOS Terminal | pending | pending | pending | pending | pending |
| iTerm2 | pending | pending | pending | pending | pending |
| Linux terminal | pending | pending | pending | pending | pending |
| SSH terminal | pending | pending | pending | pending | pending |

Record terminal version, OS, artifact SHA, size, outcome and any corrupted frame or leftover terminal mode in the relevant issue or change description. Record defects for the single OpenTUI renderer and fix blocking physical-terminal issues before release.
