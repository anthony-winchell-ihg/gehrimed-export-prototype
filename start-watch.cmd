@echo off
rem Starts live mode, and restarts it if it ever exits unexpectedly.
rem Used by Windows Task Scheduler (see README "Running it all the time").
rem Output also goes to logs\watch-yyyy-MM-dd.log.
rem
rem   exit code 0 = stopped on purpose (Ctrl+C)          -> don't restart
rem   exit code 3 = another export is already running    -> don't restart
rem   anything else = crash                                -> restart in 60 seconds
title GEHRIMed signed-note export (live)
cd /d "%~dp0"

:run
node --env-file-if-exists=.env watch.js
set CODE=%ERRORLEVEL%
if "%CODE%"=="0" goto :eof
if "%CODE%"=="3" goto :eof
echo.
echo Export stopped unexpectedly (exit code %CODE%). Restarting in 60 seconds... (close this window to stop)
timeout /t 60 /nobreak >nul
goto run
