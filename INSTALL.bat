@echo off
setlocal
title DispatchOS Unified - Install
cd /d "%~dp0"

echo.
echo [DispatchOS] Installing dependencies...
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed.
  echo Install Node.js LTS from https://nodejs.org/ and run INSTALL.bat again.
  pause
  exit /b 1
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo [DispatchOS] Created .env from .env.example
)

call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed.
  pause
  exit /b 1
)

call npm run check
if errorlevel 1 (
  echo [ERROR] TypeScript check failed.
  pause
  exit /b 1
)

call npm run build
if errorlevel 1 (
  echo [ERROR] Build failed.
  pause
  exit /b 1
)

echo.
echo [OK] DispatchOS Unified installed and built.
echo Next: double-click START.bat
pause
