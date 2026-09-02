@echo off
chcp 65001 > nul
:: يجب تشغيل هذا الملف كـAdministrator

echo.
echo ================================================
echo  تثبيت مراقب الفواتير كمهمة Windows مجدولة
echo  (يبدأ تلقائياً مع كل تشغيل للجهاز)
echo ================================================
echo.

:: التحقق من صلاحيات المدير
net session > nul 2>&1
if errorlevel 1 (
    echo [خطأ] يجب تشغيل هذا الملف كـAdministrator
    echo كليك يمين على الملف ← "Run as administrator"
    pause
    exit /b 1
)

set SCRIPT_DIR=%~dp0
:: إزالة الـbackslash الأخير من المسار
if "%SCRIPT_DIR:~-1%"=="\" set SCRIPT_DIR=%SCRIPT_DIR:~0,-1%

:: الحصول على مسار Node.js
for /f "tokens=*" %%n in ('where node.exe 2^>nul') do set NODE_PATH=%%n
if "%NODE_PATH%"=="" (
    echo [خطأ] لم يُعثر على node.exe في PATH
    pause
    exit /b 1
)
echo Node.js: %NODE_PATH%

:: حذف المهمة القديمة إن وجدت
schtasks /delete /tn "OZK-AmeenAutoPrint" /f > nul 2>&1

:: إنشاء wrapper .bat يضمن تحميل متغيرات البيئة ثم تشغيل watcher.js
(
echo @echo off
echo chcp 65001 ^> nul
echo :: تحميل المتغيرات من ملف .env إن وجد
echo if exist "%SCRIPT_DIR%\.env" (
echo   for /f "usebackq tokens=1,* delims==" %%%%a in ^("%SCRIPT_DIR%\.env"^) do set "%%%%a=%%%%b"
echo ^)
echo cd /d "%SCRIPT_DIR%"
echo "%NODE_PATH%" "%SCRIPT_DIR%\watcher.js" ^>^> "%SCRIPT_DIR%\logs\autoprint.log" 2^>^&1
) > "%SCRIPT_DIR%\run-watcher.bat"

:: إنشاء مجلد logs
if not exist "%SCRIPT_DIR%\logs" mkdir "%SCRIPT_DIR%\logs"

:: إنشاء المهمة المجدولة — تبدأ عند تشغيل Windows بعد دقيقة واحدة
schtasks /create ^
  /tn "OZK-AmeenAutoPrint" ^
  /tr "\"%SCRIPT_DIR%\run-watcher.bat\"" ^
  /sc ONSTART ^
  /delay 0001:00 ^
  /ru SYSTEM ^
  /f

if errorlevel 1 (
    echo [خطأ] فشل إنشاء المهمة المجدولة
    pause
    exit /b 1
)

echo.
echo تم التثبيت ✓
echo.
echo لتشغيله الآن فوراً (بدون إعادة تشغيل Windows):
schtasks /run /tn "OZK-AmeenAutoPrint"
echo.
echo للتحقق من السجل: %SCRIPT_DIR%\logs\autoprint.log
echo لإيقافه: schtasks /end /tn "OZK-AmeenAutoPrint"
echo لحذفه:   schtasks /delete /tn "OZK-AmeenAutoPrint" /f
echo.
pause
