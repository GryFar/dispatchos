@echo off
setlocal
title DispatchOS VDS - Install
cd /d "%~dp0"

echo.
echo [DispatchOS VDS] Installing production dependencies...

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js LTS is not installed.
  echo Install Node.js LTS x64 from https://nodejs.org/
  pause
  exit /b 1
)

if not exist ".env" (
  copy ".env.vds.example" ".env" >nul
  echo [IMPORTANT] Created .env from .env.vds.example
  echo Edit .env now: DISPATCHOS_SESSION_SECRET, DISPATCHOS_PUBLIC_URL, DISPATCHOS_HOST.
  pause
)

call npm install
if errorlevel 1 goto fail

call npm run check
if errorlevel 1 goto fail

call npm run build
if errorlevel 1 goto fail

echo.
echo [OK] DispatchOS VDS build is ready.
echo Next: run START_VDS.bat
pause
exit /b 0

:fail
echo.
echo [ERROR] Install/build failed.
pause
exit /b 1
