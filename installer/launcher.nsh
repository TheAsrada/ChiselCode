!ifndef CHISEL_LAUNCHER_INCLUDED
!define CHISEL_LAUNCHER_INCLUDED
!define CHISEL_LAUNCH_ARGS "--launcher"

; Shortcut/finish-page launch is application intent, never an inherited workspace.
!macro ChiselCreateLauncherShortcut LINK
  CreateShortcut "${LINK}" "$INSTDIR\${EXENAME}" "${CHISEL_LAUNCH_ARGS}" "$INSTDIR\${ICONFILE}" 0
!macroend

Function ChiselLaunchApplication
  ExecShell "open" "$INSTDIR\${EXENAME}" "${CHISEL_LAUNCH_ARGS}"
FunctionEnd
!endif
