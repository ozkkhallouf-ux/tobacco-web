@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo تشغيل مراقب فواتير الأمين ...
echo اضغط Ctrl+C لإيقاف التشغيل
echo.
node watcher.js
pause
