; Shared by the real installer and the isolated native updater regression.
!include "LogicLib.nsh"
!include "FileFunc.nsh"
Var WasUpdate
Var RestartCwd
Var RestartSession
Var UpdateParentPid
Var UpdateLog
Var UpdateFailure

Function ChiselUpdateInit
  ${GetParameters} $R0
  ${GetOptions} $R0 "/CHISEL_CWD=" $RestartCwd
  ${GetOptions} $R0 "/CHISEL_RESUME=" $RestartSession
  ${GetOptions} $R0 "/CHISEL_PARENT_PID=" $UpdateParentPid
FunctionEnd

Function ChiselUpdateBegin
  StrCpy $UpdateFailure ""
  StrCpy $WasUpdate "0"
  IfFileExists "$INSTDIR\${EXENAME}" 0 +2
    StrCpy $WasUpdate "1"
  CreateDirectory "$INSTDIR"
  FileOpen $UpdateLog "$INSTDIR\update.log" w
  FileWriteUTF16LE $UpdateLog "ChiselCode ${VERSION}$\r$\n"
FunctionEnd

Function ChiselUpdateFail
  Pop $UpdateFailure
  FileWriteUTF16LE $UpdateLog "failed: $UpdateFailure$\r$\n"
  FileClose $UpdateLog
  SetErrorLevel 1
  ; Interactive installation reports the same reason. Silent callers use the
  ; durable log, which the next ChiselCode launch exposes in /update.
  IfSilent +2
    MessageBox MB_OK|MB_ICONSTOP "$UpdateFailure$\r$\nЖурнал: $INSTDIR\update.log"
  Abort
FunctionEnd

Function ChiselUpdateWaitForParent
  ${If} $UpdateParentPid != ""
    FileWriteUTF16LE $UpdateLog "waiting: $UpdateParentPid$\r$\n"
    FileClose $UpdateLog
    ; Hold one process handle: a reused PID cannot prolong this wait.
    System::Call 'kernel32::OpenProcess(i 0x00100000, i 0, i $UpdateParentPid) p.r0 ?e'
    Pop $1
    ${If} $0 P<> 0
      System::Call 'kernel32::WaitForSingleObject(p r0, i 60000) i.r1'
      System::Call 'kernel32::CloseHandle(p r0)'
      FileOpen $UpdateLog "$INSTDIR\update.log" a
      ${If} $1 != 0
        Push "ChiselCode не завершился за 60 секунд. Закройте его окна и повторите установку"
        Call ChiselUpdateFail
      ${EndIf}
    ${Else}
      FileOpen $UpdateLog "$INSTDIR\update.log" a
      ${If} $1 != 87
        ; ERROR_INVALID_PARAMETER means this process has already exited.
        Push "Не удалось дождаться выхода ChiselCode (ошибка Windows $1)"
        Call ChiselUpdateFail
      ${EndIf}
    ${EndIf}
  ${EndIf}
FunctionEnd

!macro ChiselStageBinary PAYLOAD
  Call ChiselUpdateBegin
  Call ChiselUpdateWaitForParent
  SetOutPath "$INSTDIR"
  ClearErrors
  SetOverwrite on
  File "/oname=chisel-update.new.exe" "${PAYLOAD}"
  ${If} ${Errors}
    Push "Не удалось подготовить новый файл. Проверьте место на диске и разрешения"
    Call ChiselUpdateFail
  ${EndIf}
  Call ChiselUpdateReplace
!macroend

Function ChiselUpdateReplace
  StrCpy $2 0
  Delete "$INSTDIR\chisel-update.previous.exe"
  update_replace_retry:
    ${If} $WasUpdate == "1"
      ; ReplaceFile keeps the old executable intact on a sharing violation.
      System::Call 'kernel32::ReplaceFileW(w "$INSTDIR\${EXENAME}", w "$INSTDIR\chisel-update.new.exe", w "$INSTDIR\chisel-update.previous.exe", i 0, p 0, p 0) i.r0'
    ${Else}
      ClearErrors
      Rename "$INSTDIR\chisel-update.new.exe" "$INSTDIR\${EXENAME}"
      StrCpy $0 1
      ${If} ${Errors}
        StrCpy $0 0
      ${EndIf}
    ${EndIf}
    ${If} $0 == 0
      IntOp $2 $2 + 1
      ${If} $2 < 20
        Sleep 500
        Goto update_replace_retry
      ${EndIf}
      ; ReplaceFile can report a partial rename failure. Restore its backup
      ; if the target disappeared; never schedule deletion of a live binary.
      IfFileExists "$INSTDIR\${EXENAME}" +2 0
        Rename "$INSTDIR\chisel-update.previous.exe" "$INSTDIR\${EXENAME}"
      Delete "$INSTDIR\chisel-update.new.exe"
      Push "Не удалось заменить chisel.exe. Закройте другие окна ChiselCode и проверьте антивирус и права на папку"
      Call ChiselUpdateFail
    ${EndIf}
  Delete "$INSTDIR\chisel-update.previous.exe"
  FileWriteUTF16LE $UpdateLog "installed: ${VERSION}$\r$\n"
FunctionEnd

Function ChiselUpdateRelaunch
  IfSilent 0 update_relaunch_done
  ${If} $WasUpdate == "1"
    ClearErrors
    ${If} $RestartCwd != ""
      SetOutPath "$RestartCwd"
      ; Append \. so a root/trailing backslash cannot escape the closing quote
      ; in the Windows argv parser. ExecShell gives a console application its
      ; own terminal instead of inheriting the installer's ignored stdio.
      ${If} $RestartSession != ""
        ExecShell "open" "$INSTDIR\${EXENAME}" '--cwd "$RestartCwd\." --resume "$RestartSession"'
      ${Else}
        ExecShell "open" "$INSTDIR\${EXENAME}" '--cwd "$RestartCwd\."'
      ${EndIf}
    ${Else}
      ExecShell "open" "$INSTDIR\${EXENAME}"
    ${EndIf}
    ${If} ${Errors}
      Push "Файлы обновлены, но не удалось открыть терминал. Запустите ChiselCode вручную"
      Call ChiselUpdateFail
    ${EndIf}
  ${EndIf}
  update_relaunch_done:
FunctionEnd

Function .onInstSuccess
  FileWriteUTF16LE $UpdateLog "success: ${VERSION}$\r$\n"
  FileClose $UpdateLog
FunctionEnd

Function .onInstFailed
  ${If} $UpdateFailure == ""
    FileWriteUTF16LE $UpdateLog "failed: Установщик завершился до окончания установки$\r$\n"
    FileClose $UpdateLog
  ${EndIf}
  SetErrorLevel 1
FunctionEnd
