@echo off
setlocal
REM dsh-brain one-click backup: packs memory into a tar.gz under <dataDir>\_backup\
REM Requires Node.js 18+ on PATH.
node "%~dp0lib\backup.mjs" %*
if errorlevel 1 (
  echo.
  echo [FAILED] see message above. Node.js 18+ required.
  pause
)
