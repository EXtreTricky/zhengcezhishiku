@echo off
cd /d C:\Users\29388\WorkBuddy\2026-09-03-09-06-43\feishu-webapp
set MOCK_LOGIN=true
set NODE_ENV=development
set PORT=4201
set CRON_ENABLED=true
set CRON_INTERVAL_HOURS=6
node policy-api\src\server.js
