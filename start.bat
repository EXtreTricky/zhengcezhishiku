@echo off
cd /d "%~dp0"
set MOCK_LOGIN=true
set NODE_ENV=development
set PORT=4201
start "" http://127.0.0.1:4201/admin/
node policy-api\src\server.js
pause
