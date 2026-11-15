@echo off
setlocal
cd /d "%~dp0"
if not exist "var" mkdir "var"
if not defined GAMERANK_PORT set "GAMERANK_PORT=8080"
echo GameRank: http://localhost:%GAMERANK_PORT%/
echo Other devices on this network can use this computer's IP and port %GAMERANK_PORT%.
python server\gamerank_server.py --host 0.0.0.0 --port %GAMERANK_PORT% --db "var\boards.db" --static "%CD%"
if errorlevel 1 pause
