; ChiselCode Windows installer (NSIS 3).
; Build from the repository root:
;   makensis /DVERSION=0.1.10 installer\chiselcode.nsi
; Produces: dist\release\ChiselCode-Setup-<VERSION>.exe
; User-level install: no admin rights needed, adds chisel.exe to the user PATH.
; NOTE: makensis resolves relative paths against the script directory
; (installer/), not the current working directory.

!ifndef VERSION
  !define VERSION "0.0.0"
!endif

!define APPNAME "ChiselCode"
!define APPID "ChiselCode"
!define EXENAME "chisel.exe"
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
SetCompressor /SOLID lzma
BrandingText "${APPNAME}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "FileDescription" "${APPNAME} Setup"
VIAddVersionKey "LegalCopyright" "MIT"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

!define MUI_ABORTWARNING
!define MUI_UNABORTWARNING

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "..\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Russian"

Section "Install" SecInstall
  SetOutPath "$INSTDIR"
  File "/oname=${EXENAME}" "..\dist\release\chisel-windows-x64.exe"
  WriteUninstaller "$INSTDIR\${UNINSTALLER}"

  WriteRegStr HKCU "Software\${APPID}" "InstallDir" "$INSTDIR"

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}" "DisplayName" "${APPNAME} ${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}" "UninstallString" "$INSTDIR\${UNINSTALLER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}" "DisplayIcon" "$INSTDIR\${EXENAME}"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}" "NoRepair" 1

  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\${EXENAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\Uninstall.lnk" "$INSTDIR\${UNINSTALLER}"

  Push "$INSTDIR"
  Call AddToUserPath
SectionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}\Uninstall.lnk"
  RMDir "$SMPROGRAMS\${APPNAME}"

  Push "$INSTDIR"
  Call un.RemoveFromUserPath

  Delete "$INSTDIR\${EXENAME}"
  Delete "$INSTDIR\${UNINSTALLER}"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}"
  DeleteRegKey HKCU "Software\${APPID}"
SectionEnd

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
