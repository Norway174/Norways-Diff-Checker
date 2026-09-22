Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "FileFunc.nsh"

!ifndef APP_COMMIT
  !error "APP_COMMIT is required"
!endif
!ifndef APP_VERSION
  !define APP_VERSION "${APP_COMMIT}"
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
InstallDir "$LOCALAPPDATA\NorwaysDiffChecker"
InstallDirRegKey HKCU "Software\NorwaysDiffChecker" "AppPath"
ShowInstDetails show
!define MUI_ABORTWARNING
!define MUI_ICON "..\assets\app-icon.ico"
!define MUI_UNICON "..\assets\app-icon.ico"

Var Action
Var NoLaunch
Var RadioUpdate
Var RadioRepair
Var RadioUninstall

!insertmacro MUI_PAGE_WELCOME
Page custom MaintenancePage MaintenanceLeave
!define MUI_PAGE_CUSTOMFUNCTION_PRE DirectoryPre
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE DirectoryLeave
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\norways-diff-checker.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Open Norways Diff Checker"
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Create desktop shortcut"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateDesktopShortcut
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  StrCpy $Action "install"
  StrCpy $NoLaunch "0"
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/NOLAUNCH" $1
  ${IfNot} ${Errors}
    StrCpy $NoLaunch "1"
  ${EndIf}
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
    ${GetFileName} "$2" $3
    StrCmp /i $3 "app" 0 +2
      ${GetParent} "$2" $2
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
  ${NSD_CreateLabel} 0 0 100% 34u "Norways Diff Checker is installed. Choose what to do with this installer (version ${APP_VERSION})."
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
    ReadRegStr $2 HKCU "Software\NorwaysDiffChecker" "AppPath"
    ${GetFileName} "$2" $3
    StrCmp /i $3 "app" 0 +2
      ${GetParent} "$2" $2
    StrCpy $INSTDIR $2
  ${EndIf}
FunctionEnd

Function DirectoryPre
  ${If} $Action != "install"
    Abort
  ${EndIf}
FunctionEnd

Function DirectoryLeave
  ${GetFileName} "$INSTDIR" $0
  StrCpy $1 $0 18
  StrCmp /i $1 "NorwaysDiffChecker" DirectoryDone
  StrCpy $INSTDIR "$INSTDIR\NorwaysDiffChecker"
  DirectoryDone:
FunctionEnd

Section "Install" MainSection
  ${If} $Action == "uninstall"
    ReadRegStr $0 HKCU "Software\NorwaysDiffChecker" "AppPath"
    Exec '"$0\Uninstall.exe"'
    Quit
  ${EndIf}
  ${If} $Action == "install"
    ${GetFileName} "$INSTDIR" $0
    StrCpy $1 $0 18
    StrCmp /i $1 "NorwaysDiffChecker" +2
      StrCpy $INSTDIR "$INSTDIR\NorwaysDiffChecker"
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
  DeleteRegValue HKCU "Software\NorwaysDiffChecker" "DataPath"
  WriteRegStr HKCU "Software\NorwaysDiffChecker" "InstalledCommit" "${APP_COMMIT}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NorwaysDiffChecker" "DisplayName" "Norways Diff Checker"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NorwaysDiffChecker" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NorwaysDiffChecker" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NorwaysDiffChecker" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NorwaysDiffChecker" "NoModify" 1
  CreateDirectory "$SMPROGRAMS\Norways Diff Checker"
  CreateShortCut "$SMPROGRAMS\Norways Diff Checker\Norways Diff Checker.lnk" "$INSTDIR\norways-diff-checker.exe"
  IfSilent SilentUpdate InstallDone
  SilentUpdate:
    ${If} $Action == "update"
      ${If} $NoLaunch != "1"
        Exec '"$INSTDIR\norways-diff-checker.exe"'
      ${EndIf}
    ${EndIf}
  InstallDone:
SectionEnd

Function CreateDesktopShortcut
  CreateShortCut "$DESKTOP\Norways Diff Checker.lnk" "$INSTDIR\norways-diff-checker.exe"
FunctionEnd

Section "Uninstall"
  Delete "$DESKTOP\Norways Diff Checker.lnk"
  Delete "$SMPROGRAMS\Norways Diff Checker\Norways Diff Checker.lnk"
  RMDir "$SMPROGRAMS\Norways Diff Checker"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NorwaysDiffChecker"
  DeleteRegKey HKCU "Software\NorwaysDiffChecker"
  Delete "$INSTDIR\norways-diff-checker.exe"
  Delete /REBOOTOK "$INSTDIR\Installer.exe"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR\app"
  RMDir "$INSTDIR"
SectionEnd
