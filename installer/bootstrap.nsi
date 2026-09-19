Unicode true
RequestExecutionLevel user
Name "Norways Diff Checker"
OutFile "..\dist\NorwaysDiffCheckerInstaller.exe"
InstallDir "$LOCALAPPDATA\NorwaysDiffChecker\program"
ShowInstDetails show
AutoCloseWindow true
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!ifndef SOURCE_CONFIG
  !error "SOURCE_CONFIG define is required"
!endif
Section "Install"
  ReadEnvStr $0 "LOCALAPPDATA"
  StrCpy $INSTDIR "$0\NorwaysDiffChecker\program"
  CreateDirectory "$TEMP\NorwaysDiffCheckerBootstrap"
  SetOutPath "$TEMP\NorwaysDiffCheckerBootstrap"
  File /oname=install.ps1 "install.ps1"
  File /oname=source.json "${SOURCE_CONFIG}"
  StrCpy $1 "install"
  ${If} $CMDLINE != ""
    ${GetParameters} $2
    ${If} $2 == "-update"
      StrCpy $1 "update"
    ${ElseIf} $2 == "-update-silent"
      StrCpy $1 "update-silent"
    ${EndIf}
  ${EndIf}
  DetailPrint "Installing latest committed build..."
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$TEMP\NorwaysDiffCheckerBootstrap\install.ps1" -Mode "$1" -SourceConfig "$TEMP\NorwaysDiffCheckerBootstrap\source.json" -InstallerPath "$EXEPATH"'
  Pop $3
  ${If} $3 != 0
    MessageBox MB_ICONSTOP "Installation failed. See $LOCALAPPDATA\NorwaysDiffChecker\settings\installer.log."
    Abort
  ${EndIf}
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortCut "$SMPROGRAMS\Norways Diff Checker.lnk" "$INSTDIR\Norways Diff Checker.exe"
  CreateShortCut "$DESKTOP\Norways Diff Checker.lnk" "$INSTDIR\Norways Diff Checker.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NorwaysDiffChecker" "DisplayName" "Norways Diff Checker"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NorwaysDiffChecker" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NorwaysDiffChecker" "InstallLocation" "$INSTDIR"
  Delete "$TEMP\NorwaysDiffCheckerBootstrap\install.ps1"
  Delete "$TEMP\NorwaysDiffCheckerBootstrap\source.json"
  RMDir "$TEMP\NorwaysDiffCheckerBootstrap"
SectionEnd
Section "Uninstall"
  ReadEnvStr $0 "LOCALAPPDATA"
  StrCpy $1 "$0\NorwaysDiffChecker\program"
  ${If} $INSTDIR != $1
    MessageBox MB_ICONSTOP "Unexpected install path. Uninstall stopped."
    Abort
  ${EndIf}
  Delete "$SMPROGRAMS\Norways Diff Checker.lnk"
  Delete "$DESKTOP\Norways Diff Checker.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NorwaysDiffChecker"
  RMDir /r "$INSTDIR"
  MessageBox MB_YESNO|MB_ICONQUESTION "Also remove settings and saved comparisons?" IDNO keepData
    RMDir /r "$0\NorwaysDiffChecker\settings"
  keepData:
  RMDir "$0\NorwaysDiffChecker"
SectionEnd
