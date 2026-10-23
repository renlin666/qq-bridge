@echo off
cd /d "%~dp0"
node scripts\quark-client.mjs --open
if errorlevel 1 pause
