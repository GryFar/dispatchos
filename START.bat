@echo off
setlocal
title DispatchOS Unified
cd /d "%~dp0"

if not exist ".env" copy ".env.example" ".env" >nul

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed. Install Node.js LTS from https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [DispatchOS] node_modules missing. Running npm install...
  call npm install
)

if not exist "dist\index.cjs" (
  echo [DispatchOS] Production build missing. Running npm run build...
  call npm run build
)

echo [DispatchOS] Starting at http://localhost:5000
start "" "http://localhost:5000"
call npm run start
pause
