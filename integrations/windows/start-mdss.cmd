@echo off
REM ============================================================================
REM  mdss quick start for Windows (double-clickable)
REM    usage:  start-mdss.cmd ^<notes-dir^> [port]
REM    example: start-mdss.cmd D:\Notes
REM  Spawns a hidden `mdss serve --watch` when needed, then the tray icon.
REM ============================================================================
setlocal
set "SCRIPT_DIR=%~dp0"
if "%~1"=="" (
  echo Usage: start-mdss.cmd ^<notes-dir^> [port]
  echo   notes-dir : folder with your .md files
  echo   port      : optional, default 8747
  pause
  exit /b 1
)
set "ARGS=-Db "%~1""
if not "%~2"=="" set "ARGS=%ARGS% -Port %~2"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%Start-Mdss.ps1" %ARGS%
if errorlevel 1 pause
endlocal
