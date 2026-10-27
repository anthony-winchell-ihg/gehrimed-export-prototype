@echo off
rem Starts eCW live mode (ecw-watch.js), and restarts it if it ever exits unexpectedly.
rem Runs next to start-watch.cmd (the GEHRIMed export); give it its own Task Scheduler task.
rem Output also goes to logs\ecw-watch-yyyy-MM-dd.log.
rem
rem Options are passed through to ecw-watch.js, e.g.:
rem   start-ecw-watch.cmd --show
rem
rem   exit code 0 = stopped on purpose (Ctrl+C)            -> don't restart
rem   exit code 2 = a setting in .env is wrong             -> don't restart (fix it first)
rem   exit code 3 = another eCW run is already going       -> don't restart
rem   anything else = crash                                  -> restart in 60 seconds
title eCW upload (live)
cd /d "%~dp0"

:run
node --env-file-if-exists=.env ecw-watch.js %*
set CODE=%ERRORLEVEL%
if "%CODE%"=="0" goto :eof
if "%CODE%"=="2" goto :eof
if "%CODE%"=="3" goto :eof
echo.
echo eCW upload stopped unexpectedly (exit code %CODE%). Restarting in 60 seconds... (close this window to stop)
timeout /t 60 /nobreak >nul
goto run
