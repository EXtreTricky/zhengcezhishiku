@echo off
rem 无窗口后台启动 policy-api（供 schtasks / 计划任务调用）
cd /d "%~dp0"
set MOCK_LOGIN=true
set NODE_ENV=development
set PORT=3000
set SPA_DIR=C:\Users\29388\WorkBuddy\2026-08-27-12-59-41\policy-kb\dist\client\client
node policy-api\src\server.js >> policy-api\server-start.log 2>&1
