@echo off
rem Open the qq-bridge local console in the default browser, with the token attached.
rem ASCII-only on purpose (cmd.exe reads .cmd in the OEM codepage).
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if not exist "state\console-token" (
  echo [qq-bridge] state\console-token not found - start the bridge once first.
  pause
  exit /b 1
)
set /p TOKEN=<"state\console-token"
start "" "http://127.0.0.1:3100/?token=%TOKEN%"