Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "FileFunc.nsh"

!ifndef APP_COMMIT
  !error "APP_COMMIT is required"
!endif
!ifndef PORTABLE_DIR
  !error "PORTABLE_DIR is required"
!endif
!ifndef OUTPUT
  !define OUTPUT "Installer.exe"
!endif

Name "Norways Diff Checker"
OutFile "${OUTPUT}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\NorwaysDiffChecker\app"
InstallDirRegKey HKCU "Software\NorwaysDiffChecker" "AppPath"
ShowInstDetails show
!define MUI_ABORTWARNING
!define MUI_ICON "..\assets\app-icon.ico"
!define MUI_UNICON "..\assets\app-icon.ico"

Var Action
Var RadioUpdate
Var RadioRepair
Var RadioUninstall

!insertmacro MUI_PAGE_WELCOME
Page custom MaintenancePage MaintenanceLeave
!define MUI_PAGE_CUSTOMFUNCTION_PRE DirectoryPre
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  StrCpy $Action "install"
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/UPDATE" $1
  ${IfNot} ${Errors}
    StrCpy $Action "update"
  ${EndIf}
  ClearErrors
  ${GetOptions} $0 "/UNINSTALL" $1
  ${IfNot} ${Errors}
    ReadRegStr $2 HKCU "Software\NorwaysDiffChecker" "AppPath"
    ${If} $2 == ""
      MessageBox MB_ICONEXCLAMATION "Norways Diff Checker is not installed."
    ${Else}
      Exec '"$2\Uninstall.exe"'
    ${EndIf}
    Quit
  ${EndIf}
  ${If} $Action == "update"
    ReadRegStr $2 HKCU "Software\NorwaysDiffChecker" "AppPath"
    ${If} $2 == ""
      MessageBox MB_ICONSTOP "An installed copy is required for /UPDATE."
      Abort
    ${EndIf}
    StrCpy $INSTDIR $2
  ${EndIf}
FunctionEnd

Function MaintenancePage
  ${If} $Action == "update"
    Abort
  ${EndIf}
  ReadRegStr $0 HKCU "Software\NorwaysDiffChecker" "AppPath"
  ${If} $0 == ""
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 34u "Norways Diff Checker is installed. Choose what to do with this installer (version ${APP_COMMIT})."
  Pop $0
  ${NSD_CreateRadioButton} 0 42u 100% 18u "Update to this version"
  Pop $RadioUpdate
  ${NSD_CreateRadioButton} 0 66u 100% 18u "Repair this version"
  Pop $RadioRepair
  ${NSD_CreateRadioButton} 0 90u 100% 18u "Uninstall"
  Pop $RadioUninstall
  ${NSD_Check} $RadioUpdate
  nsDialogs::Show
FunctionEnd

Function MaintenanceLeave
  ${NSD_GetState} $RadioUninstall $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $Action "uninstall"
  ${Else}
    ${NSD_GetState} $RadioRepair $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $Action "repair"
    ${Else}
      StrCpy $Action "update"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function DirectoryPre
  ${If} $Action != "install"
    Abort
  ${EndIf}
FunctionEnd

Section "Install" MainSection
  ${If} $Action == "uninstall"
    ReadRegStr $0 HKCU "Software\NorwaysDiffChecker" "AppPath"
    Exec '"$0\Uninstall.exe"'
    Quit
  ${EndIf}
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=install.ps1 "install.ps1"
  SetOutPath "$PLUGINSDIR\portable"
  File /r "${PORTABLE_DIR}\*"
  DetailPrint "Installing app build ${APP_COMMIT}..."
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\install.ps1" -InstallDir "$INSTDIR" -SourceDir "$PLUGINSDIR\portable" -ExpectedCommit "${APP_COMMIT}" -SelfInstaller "$EXEPATH"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Installation failed. Check the installer details for the file error."
    Abort
  ${EndIf}
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\NorwaysDiffChecker" "AppPath" "$INSTDIR"
  WriteRegStr HKCU "Software\NorwaysDiffChecker" "DataPath" "$LOCALAPPDATA\NorwaysDiffChecker"
  WriteRegStr HKCU "Software\NorwaysDiffChecker" "InstalledCommit" "${APP_COMMIT}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NorwaysDiffChecker" "DisplayName" "Norways Diff Checker"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NorwaysDiffChecker" "DisplayVersion" "${APP_COMMIT}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NorwaysDiffChecker" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NorwaysDiffChecker" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NorwaysDiffChecker" "NoModify" 1
  CreateDirectory "$SMPROGRAMS\Norways Diff Checker"
  CreateShortCut "$SMPROGRAMS\Norways Diff Checker\Norways Diff Checker.lnk" "$INSTDIR\norways-diff-checker.exe"
  CreateShortCut "$DESKTOP\Norways Diff Checker.lnk" "$INSTDIR\norways-diff-checker.exe"
  Exec '"$INSTDIR\norways-diff-checker.exe"'
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\Norways Diff Checker.lnk"
  Delete "$SMPROGRAMS\Norways Diff Checker\Norways Diff Checker.lnk"
  RMDir "$SMPROGRAMS\Norways Diff Checker"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NorwaysDiffChecker"
  DeleteRegKey HKCU "Software\NorwaysDiffChecker"
  Delete "$INSTDIR\norways-diff-checker.exe"
  Delete /REBOOTOK "$INSTDIR\Installer.exe"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR\licenses"
  RMDir "$INSTDIR"
SectionEnd
