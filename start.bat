@echo off
cd /d "%~dp0"
set MOCK_LOGIN=true
set NODE_ENV=development
set PORT=3000
set SPA_DIR=C:\Users\29388\WorkBuddy\2026-08-27-12-59-41\policy-kb\dist\client\client
start "" http://127.0.0.1:3000
node policy-api\src\server.js
pause
