; ChiselCode Windows installer (NSIS 3, MUI2).
; Build from the repository root:
;   makensis /DVERSION=0.4.0 /DVERSION_NUMERIC=0.4.0.0 installer\chiselcode.nsi
; Produces: dist\release\ChiselCode-Setup-<VERSION>.exe
; VERSION — полная версия для имён и подписей (может быть с суффиксом
; вроде 0.5.20-hotfix.1), VERSION_NUMERIC — только цифры X.X.X.X
; для VIProductVersion (NSIS не принимает суффиксы).
; User-level install: no admin rights needed, adds chisel.exe to the user PATH.
; NOTE: makensis resolves relative paths against the script directory
; (installer/), not the current working directory.
;
; Brand assets live in installer\assets. The installer uses generated photo
; artwork (welcome-source.png), converted to a high-resolution 24-bit BMP.
; No decorative drawing scripts run during packaging; see assets\README.md.
; Silent update (/S, used by the in-app `/update` command): no pages,
; installs quietly and relaunches the app if it was already installed.

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef VERSION_NUMERIC
  !define VERSION_NUMERIC "0.0.0.0"
!endif

!define APPNAME "ChiselCode"
!define APPID "ChiselCode"
!define EXENAME "chisel.exe"
!define ICONFILE "icon.ico"
!define UNINSTALLER "Uninstall.exe"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "StrFunc.nsh"
!include "WinMessages.nsh"

${Using:StrFunc} StrStr

Name "${APPNAME} ${VERSION}"
OutFile "..\dist\release\ChiselCode-Setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\${APPNAME}"
InstallDirRegKey HKCU "Software\${APPID}" "InstallDir"
RequestExecutionLevel user
Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma
BrandingText "${APPNAME} ${VERSION}"
SetFont "Segoe UI" 9

!define MUI_ICON "assets\${ICONFILE}"
!define MUI_UNICON "assets\${ICONFILE}"

VIProductVersion "${VERSION_NUMERIC}"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "FileDescription" "${APPNAME} Setup"
VIAddVersionKey "LegalCopyright" "MIT"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

; Quiet native pages with a photographic welcome/finish panel.
!define MUI_TEXTCOLOR "172033"
!define MUI_BGCOLOR "FFFFFF"
!define MUI_WELCOMEFINISHPAGE_BITMAP "assets\welcome.bmp"
!define MUI_WELCOMEFINISHPAGE_BITMAP_STRETCH "FitControl"

!define MUI_ABORTWARNING
!define MUI_UNABORTWARNING

!define MUI_WELCOMEPAGE_TITLE "Ваш код.$\r$\nТочнее с ${APPNAME}."
!define MUI_WELCOMEPAGE_TEXT "Помощник, который читает проект, объясняет код и помогает вносить изменения.$\r$\n$\r$\nУстановка для вашей учётной записи — без прав администратора.$\r$\n$\r$\nДобавим команду chisel в терминал и ярлык в меню «Пуск».$\r$\n$\r$\nПри первом запуске выберите провайдера и модель."

!define MUI_FINISHPAGE_TITLE "${APPNAME} готов к работе"
!define MUI_FINISHPAGE_TEXT "Откройте новый терминал в папке проекта и выполните команду chisel.$\r$\n$\r$\nПри первом запуске приложение поможет настроить подключение к выбранной модели."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXENAME}"
!define MUI_FINISHPAGE_RUN_TEXT "Запустить ${APPNAME}"
!define MUI_FINISHPAGE_LINK "Что нового в этом релизе"
!define MUI_FINISHPAGE_LINK_LOCATION "https://github.com/TheAsrada/ChiselCode/releases"
!define MUI_FINISHPAGE_LINK_COLOR "245FCB"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "..\LICENSE"
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Russian"

LangString DESC_SecMain ${LANG_RUSSIAN} "Файлы ChiselCode, команда chisel в PATH и ярлык в меню «Пуск» (обязательно)."
LangString DESC_SecDesktop ${LANG_RUSSIAN} "Ярлык для запуска ChiselCode на рабочем столе."

; Remembers whether we are updating an existing install (for silent relaunch).
Var WasUpdate
; Set when the main binary could not be replaced (still locked after retries):
; silent relaunch must not start the stale copy then.
Var InstallFailed

Function .onInit
  StrCpy $InstallFailed "0"
  IfFileExists "$INSTDIR\${EXENAME}" 0 done
    StrCpy $WasUpdate "1"
  done:
FunctionEnd

Section "ChiselCode" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"
  ; The updater (/update) exits the app right before launching us, but give a
  ; running instance a grace period instead of failing instantly when the
  ; file is still locked. Last resort: defer the stale file to reboot.
  StrCpy $R0 0
  delete_retry:
    ClearErrors
    Delete "$INSTDIR\${EXENAME}"
    ${If} ${Errors}
      IntOp $R0 $R0 + 1
      ${If} $R0 >= 20
        Delete /REBOOTOK "$INSTDIR\${EXENAME}"
        Goto delete_done
      ${EndIf}
      Sleep 500
      Goto delete_retry
    ${EndIf}
  delete_done:
  ClearErrors
  File "/oname=${EXENAME}" "..\dist\release\chisel-windows-x64.exe"
  ${If} ${Errors}
    StrCpy $InstallFailed "1"
  ${EndIf}
  File "/oname=${ICONFILE}" "assets\${ICONFILE}"
  File "/oname=LICENSE.txt" "..\LICENSE"
  File "/oname=README.txt" "README.txt"
  ; Remove skills retired in v0.5.29 during upgrades.
  Delete "$INSTDIR\skills\review\SKILL.md"
  Delete "$INSTDIR\skills\commit\SKILL.md"
  RMDir "$INSTDIR\skills\review"
  RMDir "$INSTDIR\skills\commit"
  ; Bundled skills (/code-review, /skill-creator): explicit file list,
  ; so the uninstaller below removes exactly what we shipped and never
  ; touches skills added by the user afterwards.
  SetOutPath "$INSTDIR\skills\code-review"
  File "..\skills\code-review\SKILL.md"
  SetOutPath "$INSTDIR\skills\skill-creator"
  File "..\skills\skill-creator\SKILL.md"
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\${UNINSTALLER}"

  WriteRegStr HKCU "Software\${APPID}" "InstallDir" "$INSTDIR"

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}" "DisplayName" "${APPNAME} ${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}" "UninstallString" "$INSTDIR\${UNINSTALLER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}" "DisplayIcon" "$INSTDIR\${ICONFILE},0"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}" "NoRepair" 1

  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\${EXENAME}" "" "$INSTDIR\${ICONFILE}" 0
  CreateShortcut "$SMPROGRAMS\${APPNAME}\Uninstall.lnk" "$INSTDIR\${UNINSTALLER}"

  Push "$INSTDIR"
  Call AddToUserPath
  ; Ярлыки пересозданы с новым icon.ico, но Explorer кэширует значки
  ; и без пинка показывал бы старый ромб: сбрасываем кэш иконок.
  Call RefreshShellIcons
SectionEnd

Section /o "Ярлык на рабочем столе" SecDesktop
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${EXENAME}" "" "$INSTDIR\${ICONFILE}" 0
  Call RefreshShellIcons
SectionEnd

; Silent update (/update command): relaunch the app when we replaced one.
; Skipped when the binary could not be replaced: launching the stale copy
; would fake a successful update on the old version.
Section "-RelaunchAfterSilentUpdate"
  IfSilent 0 relaunch_done
  ${If} $WasUpdate == "1"
  ${AndIf} $InstallFailed == "0"
    Exec "$INSTDIR\${EXENAME}"
  ${EndIf}
  relaunch_done:
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} $(DESC_SecMain)
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} $(DESC_SecDesktop)
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  Delete "$DESKTOP\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}\Uninstall.lnk"
  RMDir "$SMPROGRAMS\${APPNAME}"

  Push "$INSTDIR"
  Call un.RemoveFromUserPath

  Delete "$INSTDIR\${EXENAME}"
  Delete "$INSTDIR\${ICONFILE}"
  Delete "$INSTDIR\LICENSE.txt"
  Delete "$INSTDIR\README.txt"
  Delete "$INSTDIR\skills\review\SKILL.md"
  Delete "$INSTDIR\skills\commit\SKILL.md"
  Delete "$INSTDIR\skills\code-review\SKILL.md"
  Delete "$INSTDIR\skills\skill-creator\SKILL.md"
  RMDir "$INSTDIR\skills\review"
  RMDir "$INSTDIR\skills\commit"
  RMDir "$INSTDIR\skills\code-review"
  RMDir "$INSTDIR\skills\skill-creator"
  RMDir "$INSTDIR\skills"
  ; Legacy: custom markdown commands replaced by skills in v0.5.3.
  Delete "$INSTDIR\commands\review.md"
  Delete "$INSTDIR\commands\commit.md"
  RMDir "$INSTDIR\commands"
  Delete "$INSTDIR\${UNINSTALLER}"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}"
  DeleteRegKey HKCU "Software\${APPID}"
  Call un.RefreshShellIcons
SectionEnd

; Forces Explorer to drop cached icons (SHCNE_ASSOCCHANGED): otherwise
; shortcuts keep showing the previous icon.ico after an update.
Function RefreshShellIcons
  System::Call 'shell32.dll::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
FunctionEnd

Function un.RefreshShellIcons
  System::Call 'shell32.dll::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
FunctionEnd

; Adds $0 to the user PATH (HKCU\Environment) once, then broadcasts the change.
Function AddToUserPath
  Exch $0
  Push $1
  Push $2
  Push $3
  ReadRegStr $1 HKCU "Environment" "Path"
  ${If} $1 == ""
    WriteRegExpandStr HKCU "Environment" "Path" "$0"
  ${Else}
    StrCpy $2 ";$1;"
    ${StrStr} $3 $2 ";$0;"
    ${If} $3 == ""
      WriteRegExpandStr HKCU "Environment" "Path" "$1;$0"
    ${EndIf}
  ${EndIf}
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Removes $0 from the user PATH (only the exact entry we added).
; Pure-instruction loop: StrFunc macros cannot be Called from uninstall code.
Function un.RemoveFromUserPath
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  ReadRegStr $1 HKCU "Environment" "Path"
  ${If} $1 != ""
    StrCpy $2 ";$1;"
    StrCpy $3 ""
    StrLen $4 ";$0;"
    ${Do}
      StrLen $5 $2
      ${If} $5 == 0
        ${Break}
      ${EndIf}
      StrCpy $6 $2 $4
      ${If} $6 == ";$0;"
        StrCpy $3 "$3;"
        StrCpy $2 $2 "" $4
      ${Else}
        StrCpy $7 $2 1
        StrCpy $3 "$3$7"
        StrCpy $2 $2 "" 1
      ${EndIf}
    ${Loop}
    StrCpy $6 $3 1
    ${If} $6 == ";"
      StrCpy $3 $3 "" 1
    ${EndIf}
    StrCpy $6 $3 1 -1
    ${If} $6 == ";"
      StrCpy $3 $3 -1
    ${EndIf}
    WriteRegExpandStr HKCU "Environment" "Path" "$3"
  ${EndIf}
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
