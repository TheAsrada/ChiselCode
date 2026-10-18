Unicode true
RequestExecutionLevel user
!define EXENAME "chisel.exe"
!define VERSION "9.9.9"
Name "Isolated ChiselCode update regression"
OutFile "${OUTPUT}"
InstallDir "${DESTINATION}"
!include "..\..\installer\update.nsh"
Function .onInit
  Call ChiselUpdateInit
FunctionEnd
Section
  !insertmacro ChiselStageBinary "${PAYLOAD}"
  Call ChiselUpdateRelaunch
SectionEnd
