@echo off
setlocal
title DispatchOS VDS - Check
cd /d "%~dp0"

echo [1/6] Node
node -v || goto fail

echo [2/6] Dependencies
if not exist "node_modules" (
  echo [ERROR] node_modules missing. Run INSTALL_VDS.bat.
  goto fail
)

echo [3/6] TypeScript
call npm run check || goto fail

echo [4/6] Build
call npm run build || goto fail

echo [5/6] Smoke
call npm run smoke || goto fail

echo [6/6] VDS env sanity
findstr /C:"DISPATCHOS_DEPLOYMENT_MODE=vds" .env >nul 2>nul
if errorlevel 1 echo [WARN] .env is not set to VDS mode.
findstr /C:"REPLACE_WITH_48_BYTE_RANDOM_SECRET" .env >nul 2>nul
if not errorlevel 1 echo [WARN] Replace DISPATCHOS_SESSION_SECRET before real VDS use.

echo.
echo [OK] VDS check complete.
pause
exit /b 0

:fail
echo.
echo [ERROR] VDS check failed.
pause
exit /b 1
