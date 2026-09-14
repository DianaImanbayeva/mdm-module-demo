@echo off
setlocal
cd /d "%~dp0"

echo Starting MDM module on port 9009.
echo.

if not exist "backend\.env" (
  echo backend\.env not found - copy backend\.env.example and fill in real values first.
  pause
  exit /b 1
)

cd /d "%~dp0backend"
call npm install
if errorlevel 1 exit /b 1

cd /d "%~dp0frontend"
call npm install
if errorlevel 1 exit /b 1
call npm run build
if errorlevel 1 exit /b 1

cd /d "%~dp0backend"
node src\server.js
