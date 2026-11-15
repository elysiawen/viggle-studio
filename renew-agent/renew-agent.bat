@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Viggle Renew Agent

where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 node，请先安装 Node.js 20+ 并加入 PATH
  pause
  exit /b 1
)

node renew-agent.mjs
echo.
echo 助手已退出，可以关掉这个窗口了。
pause
