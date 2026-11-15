@echo off
rem Start the GameRank static server on http://localhost:8080
python -m http.server 8080 --bind 127.0.0.1
