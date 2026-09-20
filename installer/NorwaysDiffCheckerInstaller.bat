@echo off
setlocal EnableExtensions
set "ENGINE=%~dp0engine.ps1"
if not exist "%ENGINE%" (
  echo Installer engine is missing: "%ENGINE%"
  exit /b 2
)

set "MODE=%~1"
if /I "%MODE%"=="-help" goto help
if /I "%MODE%"=="/?" goto help
if /I "%MODE%"=="-install" set "MODE=install"
if /I "%MODE%"=="-update" set "MODE=update"
if /I "%MODE%"=="-update-silent" set "MODE=update-silent"
if /I "%MODE%"=="-uninstall" set "MODE=uninstall"
if /I "%MODE%"=="-uninstall-keep" set "MODE=uninstall-keep"
if /I "%MODE%"=="-uninstall-delete" set "MODE=uninstall-delete"
if "%MODE%"=="" goto menu
if /I "%MODE%"=="install" goto run
if /I "%MODE%"=="update" goto run
if /I "%MODE%"=="update-silent" goto run
if /I "%MODE%"=="uninstall" goto run
if /I "%MODE%"=="uninstall-keep" goto run
if /I "%MODE%"=="uninstall-delete" goto run
echo Unknown argument: %MODE%
goto help

:menu
cls
echo ==========================================================
echo                  NORWAYS DIFF CHECKER
echo ==========================================================
echo.
echo   [I]  Install or repair the latest committed version
echo   [U]  Update the installed version
echo   [R]  Remove the app
echo   [Q]  Quit
echo.
choice /C IURQ /N /M "Choose an action [I/U/R/Q]: "
if errorlevel 4 exit /b 0
if errorlevel 3 set "MODE=uninstall"
if errorlevel 2 if not errorlevel 3 set "MODE=update"
if errorlevel 1 if not errorlevel 2 set "MODE=install"
goto run

:run
echo.
echo Running %MODE%...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ENGINE%" -Mode "%MODE%" -InstallerPath "%~f0"
set "RESULT=%ERRORLEVEL%"
if not "%MODE%"=="update-silent" (
  echo.
  if "%RESULT%"=="0" (echo Finished.) else (echo Failed with code %RESULT%. See the installer log in local AppData.)
  if "%~1"=="" pause
)
exit /b %RESULT%

:help
echo Usage: NorwaysDiffCheckerInstaller.bat [-install ^| -update ^| -update-silent ^| -uninstall ^| -uninstall-keep ^| -uninstall-delete]
echo With no arguments, an interactive menu is shown.
exit /b 0
