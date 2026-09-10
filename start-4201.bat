@echo off
title PolicyKB 4201
cd /d C:\Users\29388\WorkBuddy\2026-09-03-09-06-43\feishu-webapp
set MOCK_LOGIN=true
set NODE_ENV=development
set PORT=4201
set CRON_ENABLED=true
set CRON_INTERVAL_HOURS=6
echo [%date% %time%] Starting policy-api on port 4201...
node policy-api\src\server.js
echo [%date% %time%] Server exited with code %ERRORLEVEL%
pause
