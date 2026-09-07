@echo off
cd /d "%~dp0"
set MOCK_LOGIN=true
set NODE_ENV=development
set PORT=3000
echo 启动政策知识库...
echo 访问 http://127.0.0.1:3000
node policy-api\src\server.js
pause
