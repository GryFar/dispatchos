@echo off
setlocal
title DispatchOS VDS
cd /d "%~dp0"

if not exist ".env" (
  echo [ERROR] .env missing. Run INSTALL_VDS.bat first.
  pause
  exit /b 1
)

if not exist "dist\index.cjs" (
  echo [DispatchOS VDS] Missing production build. Building...
  call npm run build
  if errorlevel 1 (
    echo [ERROR] Build failed.
    pause
    exit /b 1
  )
)

echo [DispatchOS VDS] Starting production server...
echo Keep this window open, or run it under NSSM/Windows Task Scheduler for always-on mode.
call npm run start
pause
