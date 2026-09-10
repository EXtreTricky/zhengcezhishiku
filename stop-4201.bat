@echo off
chcp 65001 >nul
title 停止 4201 政策采集服务
echo ============================================
echo   停止 feishu-webapp 政策采集服务 (端口 4201)
echo ============================================
set "PID="
for /f "tokens=1,2,3,4,5" %%a in ('netstat -ano ^| findstr /i "LISTENING" ^| findstr ":4201 "') do (
  set "PID=%%e"
)
if defined PID (
  echo 找到监听进程 PID=%PID%，正在停止...
  taskkill /F /PID %PID% >nul 2>&1
  if errorlevel 1 (
    echo [!] 停止失败，请手动在任务管理器结束 PID=%PID%
  ) else (
    echo [ok] 已发送停止信号，进程 %PID% 已终止。
  )
) else (
  echo 未找到 4201 端口上的监听进程（服务可能已停止）。
)
echo ============================================
pause
