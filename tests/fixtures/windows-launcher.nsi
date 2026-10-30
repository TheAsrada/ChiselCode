Unicode true
RequestExecutionLevel user
!define EXENAME "chisel.exe"
!define ICONFILE "icon.ico"
Name "Изолированная проверка запуска ChiselCode"
OutFile "${OUTPUT}"
InstallDir "${DESTINATION}"
!include "..\..\installer\launcher.nsh"
Section
  SetOutPath "$INSTDIR"
  !insertmacro ChiselCreateLauncherShortcut "$INSTDIR\Start Menu.lnk"
  !insertmacro ChiselCreateLauncherShortcut "$INSTDIR\Desktop.lnk"
  Call ChiselLaunchApplication
SectionEnd
