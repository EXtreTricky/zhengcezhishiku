@echo off
chcp 65001 >nul
cd /d %~dp0
set NODE=C:\Users\29388\.workbuddy\binaries\node\versions\22.22.2\node.exe

echo ================================================
echo  政策采集审批后台 - 常驻守护 (端口 4201)
echo  本窗口请保持打开，或最小化；切勿关闭
echo ================================================

:loop
REM 端口已被占用则视为已在运行，仅保持心跳不重复启动
netstat -ano 2>nul | findstr /R ":4201 .*LISTENING" >nul
if %errorlevel%==0 (
  >>_keepalive.log echo [%date% %time%] 4201 已在监听，保持运行
  timeout /t 30 /nobreak >nul
  goto loop
)

>>_keepalive.log echo [%date% %time%] 4201 未监听，启动服务...
"%NODE%" _boot-v43.js >>_v43-server.log 2>&1

>>_keepalive.log echo [%date% %time%] 服务进程已退出，3 秒后尝试重启...
timeout /t 3 /nobreak >nul
goto loop
