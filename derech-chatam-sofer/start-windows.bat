@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on this computer.
  echo Go to https://nodejs.org and install the recommended LTS version, then run this file again.
  pause
  exit /b 1
)

echo Checking dependencies (this is quick if nothing changed)...
call npm install

echo.
echo Starting the app...
echo In a moment, open this address in your browser: http://localhost:3000
echo.
node server.js
pause
