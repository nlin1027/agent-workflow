@echo off
rem amctl: control CLI for the master agent. Uses the app's own Electron runtime as node when AGENTMANAGER_NODE is set.
setlocal
if defined AGENTMANAGER_NODE goto electron
node "%~dp0amctl.js" %*
exit /b %errorlevel%
:electron
set "ELECTRON_RUN_AS_NODE=1"
"%AGENTMANAGER_NODE%" "%~dp0amctl.js" %*
exit /b %errorlevel%
