@echo off
chcp 65001 > nul
echo.
echo ================================================
echo    OZK TOBACCO — Ameen AutoPrint Setup
echo ================================================
echo.

:: التحقق من Node.js
node --version > nul 2>&1
if errorlevel 1 (
    echo [خطأ] Node.js غير مثبّت.
    echo يرجى تثبيته من: https://nodejs.org
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo Node.js: %%v

echo.
echo [1/3] تثبيت حزم npm ...
cd /d "%~dp0"
npm install
if errorlevel 1 (
    echo [خطأ] فشل تثبيت الحزم.
    pause
    exit /b 1
)

echo.
echo [2/3] تحميل Chromium للطباعة (مرة واحدة فقط ^~120MB) ...
node -e "const p = require('puppeteer'); p.launch({headless:true}).then(b => { console.log('Chromium جاهز'); return b.close(); }).catch(e => { console.log('تنزيل Chromium...'); });"
npx puppeteer browsers install chrome 2>nul
if errorlevel 1 (
    node node_modules/puppeteer/install.mjs 2>nul
)
echo Chromium: جاهز ✓

echo.
echo [3/3] عرض الطابعات المثبّتة في Windows:
echo.
powershell -NonInteractive -Command "Get-Printer | Select-Object Name, PortName | Format-Table -AutoSize"

echo.
echo ================================================
echo  التثبيت اكتمل!
echo.
echo  الخطوات التالية:
echo  1. شغّل: powershell -Command "Get-Printer"
echo     وتأكد من أسماء طابعتيك ثم عدّل config.js:
echo       printers.wholesale = "اسم طابعة كانون بالضبط"
echo       printers.retail    = "اسم طابعة XPrinter بالضبط"
echo.
echo  2. ضع SumatraPDF.exe في مجلد bin\ (طباعة صامتة):
echo     حمّله من: sumatrapdfreader.org
echo.
echo  3. تأكد من تعيين متغير البيئة:
echo     AMEEN_SQL_CONNECTION_STRING
echo     (مضبوط بالفعل إذا كانت سكريبتات المزامنة تعمل)
echo.
echo  4. شغّل start.bat للتجربة
echo  5. شغّل install-service.bat لتشغيله تلقائياً مع Windows
echo ================================================
echo.
pause
