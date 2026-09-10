@echo off
rem Vtuber's Monitor Link - Windows launcher (ASCII only).
rem Prefers a bundled runtime, then the system Node on PATH.
setlocal
set "HERE=%~dp0"
set "NODE_EXE=%HERE%runtime\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
"%NODE_EXE%" "%HERE%launch.cjs" %*
if errorlevel 1 pause
endlocal
