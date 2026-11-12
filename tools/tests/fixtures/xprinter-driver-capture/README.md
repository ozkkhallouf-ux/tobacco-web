# التقاطات حقيقية لمخرجات تعريف Xprinter XP-80 (إيصالات اصطناعية، بلا ورق)

التُقطت على OZKUSER يوم 2026-11-12 بطابور مؤقت منفذه ملف. تحوي بيانات اصطناعية فقط (زبون وأسعار وهمية).

| الملف | المصدر |
|---|---|
| `printdocument-7-source.bin` / `printdocument-7-driver.prn` | إيصال 7 أسطر عبر `PrintDocument` (GDI+) — الالتقاط الأول |
| `stretchdibits-7-source.bin` / `stretchdibits-7-driver.prn` | إيصال 7 أسطر عبر `[OzkDriverReceiptPrinter]::Print` بلا صف حماية (HEAD ‏448bfedf) |

- `*-source.bin`: صفوف الصورة كما سُلِّمت للتعريف، 72 بايتاً لكل صف (بت 1 = أسود، الأعلى أولاً).
- `*-driver.prn`: البايتات التي كتبها التعريف إلى الملف حرفياً. الملف لا يسجّل التوقيت.

مرجع `tools/tests/Test-CashierReprintDriverGuard.ps1`: نموذج سلوك التعريف (حذف الأبيض أعلى الصفحة وأول صف حبر)
يجب أن يعيد إنتاج صفوف كل `.prn` من مصدره بالبايت، والمقارِن يجب أن يرفض التقاط `stretchdibits-7` (4 نقاط مفقودة).
