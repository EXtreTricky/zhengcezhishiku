@echo off
rem 无窗口后台启动 policy-api（供 schtasks / 计划任务调用）
cd /d "%~dp0"
set MOCK_LOGIN=true
set NODE_ENV=development
set PORT=4201
node policy-api\src\server.js >> policy-api\server-start.log 2>&1
