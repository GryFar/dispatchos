@echo off
setlocal
title DispatchOS Unified - Check
cd /d "%~dp0"

echo [1/5] Node version
node -v || goto fail

echo [2/5] npm version
npm -v || goto fail

echo [3/5] TypeScript check
call npm run check || goto fail

echo [4/5] Production build
call npm run build || goto fail

echo [5/5] Smoke test
call npm run smoke || goto fail

echo.
echo [OK] DispatchOS Unified checks passed.
pause
exit /b 0

:fail
echo.
echo [ERROR] DispatchOS check failed. Copy this window text and send it to support.
pause
exit /b 1
