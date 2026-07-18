@echo off
title Claude Control
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed. Install Node 20+ from https://nodejs.org then run this again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo First run: installing dependencies. This can take a few minutes...
  call npm install
  if errorlevel 1 goto :err
)

if not exist "node_modules\.prisma\client" call npm run db:generate >nul 2>&1
if not exist "packages\web\dist\index.html" (
  echo Building the app...
  call npm run build -w @cc/web
  if errorlevel 1 goto :err
)
if not exist "packages\server\dist\index.js" (
  call npm run build -w @cc/server
  if errorlevel 1 goto :err
)

echo Launching Claude Control...
echo (First launch initializes a local database, up to a minute. This window shows logs; closing it stops the app.)
call npm run start -w @cc/desktop
goto :eof

:err
echo.
echo Setup failed. Review the messages above.
echo.
pause
exit /b 1
