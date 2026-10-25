# OZK - إعادة طباعة فاتورة كاشير (يدوياً عند الطلب)

أداة Windows صغيرة تطبع نسخة من فاتورة كاشير «مبيعات مركز» على XPRINTER XP-T80Q 80MM حين
يطلبها المستخدم برقمها، حتى لو طُبعت سابقاً. **لا تغيّر الطباعة التلقائية إطلاقاً.**

## كيف تعمل

1. اختصار «OZK - إعادة طباعة فاتورة كاشير» يفتح `cashier-reprint-ui.ps1`: حقل رقم الفاتورة وزر «طباعة».
2. الواجهة تستدعي `cashier-reprint.ps1 -Mode Resolve`، الذي يقرأ من AmnDb002 بـSELECT فقط
   (حارس `Assert-CashierSelectOnly`، وحساب القراءة من `sql.secret`، ورفض sa وأي حساب
   sysadmin/db_owner/db_datawriter).
   - رقم غير موجود، أو فاتورة جملة، أو غير مرحّلة/محذوفة: رسالة واضحة ولا طباعة.
   - الرقم نفسه بأكثر من تاريخ: يظهر حقل التاريخ لاختيار الفاتورة الصحيحة.
   - تكرار بالرقم والتاريخ معاً: رفض، ولا تخمين.
3. نافذة تأكيد تعرض الرقم والتاريخ والإجمالي والزبون. وتنبّه إن كانت الفاتورة جديدة
   (قد تطبعها التلقائية أيضاً)، أو طُبعت يدوياً من قبل.
4. `-Mode Print` يعيد الحسم بأحدث بيانات الأمين، ثم يستدعي **الجسر المثبّت على الجهاز نفسه**
   بوضعه اليدوي القائم:
   `ozk-print-bridge.ps1 -Mode PrintInvoice -InvoiceType Retail -InvoiceNumber N -InvoiceDate D -ConfirmPhysicalPrint`.
   لذلك يخرج الإيصال بتنسيق الطباعة التلقائية حرفياً.

## الطباعة من جهاز بلا طابعة (OZK2026 ← OZKUSER)

OZK2026 لا يحوي XPRINTER، والجهازان لا يتشاركان طابعة. لذلك يعمل OZK2026 بـ`mode=remote`
(`config.remote.example.json`): الواجهة نفسها، لكن الحسم والطباعة يجريان **على OZKUSER**:

- النقل عبر ssh القائم على OZKUSER (Meshnet)، بلا منفذ جديد ولا مشاركة ولا خدمة جديدة.
  مفتاح مخصّص على OZK2026، مسجَّل على OZKUSER بأمر مفروض:
  ```
  command="powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\ProgramData\OZK\CashierReprint\app\cashier-reprint.ps1 -Mode Serve",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA… ozk2026-cashier-reprint
  ```
  فلا يستطيع المفتاح إلا ثلاثة أوامر بصيغة ضيقة: `resolve <رقم> [تاريخ]` و`print <رقم> <تاريخ> <معرّف> <جهاز>`
  و`status <معرّف>`. كل ما عداها مرفوض.
- `BatchMode=yes` و`StrictHostKeyChecking=yes` ببصمة OZKUSER المحفوظة، فلا كلمات سر ولا قبول لجهاز
  منتحل. وأي رد لا يحمل اسم الجهاز المتوقع (`remoteExpectedHostName`) لا يُعتمد.
- منع التكرار على OZKUSER نفسه: المعرّف يُحجز هناك قبل الطباعة، فإعادة إرسال المعرّف نفسه بسبب
  الشبكة تُرفض.
- **انقطاع أثناء الطلب:** لا إعادة طباعة تلقائية. يسأل OZK2026 عن حالة المعرّف نفسه (قراءة فقط):
  - `not_received`: لم يصل الطلب، فلم يُطبع شيء يقيناً.
  - `in_progress`: وصل ولم تُعرف نتيجته، فالحالة غير مؤكدة.
  - أو الحالة النهائية المسجّلة على OZKUSER.
  - وإن تعذّر السؤال أيضاً: `unknown`.
- السجلان: OZKUSER يسجّل كل طباعة مع `requestedFrom`، وOZK2026 يسجّل نتيجة كل طلب أرسله.

## لماذا لا تمسّ الطباعة التلقائية

- لا تقرأ `state.json` ولا تكتبه، ولا تمرّر `-StatePath`، ولا تلمس مهمة `\OZK Print Bridge`
  ولا ملفات الجسر.
- وضع `PrintInvoice` في نسخة الجسر المثبّتة (`1efcdc33`) لا يقرأ ملف الحالة ولا يكتبه، فلا يمنعه
  منع التكرار الآلي ولا يغيّره.
- نسخة الجسر مثبّتة ببصمة SHA256 في `config.json` (`expectedBridgeSha256`). أي نسخة أخرى ⇒
  لا طباعة حتى تُراجع وتُعتمد بصمتها.

## منع التكرار

- كل ضغطة «طباعة» بعد التأكيد لها معرّف طلب جديد، يُحجز بملف حصري في `requests\`.
  إعادة المحاولة التقنية بالمعرّف نفسه تُرفض (`duplicate_request`). الطلب الصريح الجديد يمرّ.
- قفل لكل فاتورة أثناء الإرسال (`locks\`): طلبان متزامنان لنفس الفاتورة ⇒ الثاني `busy`.
- الزر يتعطّل أثناء التنفيذ، وتُستهلك النقرات المتراكمة قبل إعادة تفعيله.

## نتائج الطباعة

| الحالة | المعنى |
|---|---|
| `sent` | أعاد الجسر رقم مهمة طباعة. ومعه `confirmation`: `spooler_completed` (غادرت المهمة الطابور بلا خطأ، وهذا ليس دليلاً ورقياً)، أو `printer_error`، أو `queued`، أو `unknown` |
| `failed` | الخطأ قبل إنشاء مهمة الطباعة يقيناً (SQL، الطابعة غير موجودة، OpenPrinter…). الإعادة آمنة |
| `uncertain` | الخطأ بعد بدء المهمة، أو مجهول، أو انتهت المهلة. افحص الطابعة قبل الإعادة |
| `connection_failed` | تعذّر الوصول إلى الأمين. لم يُطبع شيء |
| `blocked` | الجسر غير موجود أو نسخته غير معتمدة |
| `not_received` / `unknown` / `remote_unreachable` | للوضع البعيد، راجع القسم أعلاه |

## السجل

`C:\ProgramData\OZK\CashierReprint\logs\manual-reprints.jsonl`: سطر لكل محاولة، فيه الوقت (UTC)
والجهاز والمستخدم ومعرّف الطلب ورقم الفاتورة وتاريخها والنتيجة. بلا اسم زبون ولا أصناف ولا
مبالغ، ولا كتابة على الأمين.

## حساب خدمة محدود الصلاحيات على جهاز الطابعة (تجهيز فقط)

اليوم يعمل `-Mode Serve` على OZKUSER بحساب OZKKH (مدير). الكود يدعم تشغيله بحساب خدمة عادي.
التفعيل نفسه (الحساب والصلاحيات والمفتاح) خطوات منفصلة بموافقة المالك.

- **`bridgeSqlSource`:**
  - `user-env` (الافتراضي، سلوك التثبيت الحالي): الجسر يقرأ `AMEEN_SQL_CONNECTION_STRING` من بيئة المستخدم.
  - `tool-secret`: الأداة تفك `sql.secret` (DPAPI على مستوى الجهاز) وتمرّر السلسلة للجسر **متغيّر Process
    للعملية الفرعية وحدها**. لا يُكتب على القرص، ولا يدخل الوسائط، ولا يُنشأ سرّ جديد. وتُرفض sa وأي سلسلة بلا
    User Id، ويُفرض `ApplicationIntent=ReadOnly`. إن تعذّرت قراءة السرّ: `blocked` بلا تشغيل الجسر.
- **`bridgeScriptPath`:** يجب أن يكون مساراً محلياً مطلقاً لملف `.ps1` بعد فك المتغيرات. متغيّر غير معرَّف
  للحساب، أو مسار نسبي، أو شبكي: الإعداد مرفوض. `%LOCALAPPDATA%` يبقى للتثبيت الحالي. حساب الخدمة يستعمل
  نسخة للقراءة فقط بنفس البصمة في `C:\ProgramData\OZK\CashierReprint\bridge\` (`config.service.example.json`).
- **`enforceProtectedPaths`:** `-Mode Health` يعرض دائماً `ProtectedPaths`، أي كل صلاحية كتابة أو حذف أو
  تغيير صلاحيات أو ملكية لغير SYSTEM والمدراء وTrustedInstaller وصاحب التشغيل. يشمل الفحص مجلد الأداة،
  و`app`، و`config.json`، و`sql.secret`، والجسر وملفات كوده ومجلداته. مع `true` يمنع أي خطر من هذا النوع
  الطباعة (`blocked`). مجلدات البيانات `logs` و`requests` و`locks` خارج الفحص لأنها لا تُنفَّذ.

## التثبيت (لكل جهاز، بموافقة المالك)

```
powershell -File install.ps1 -DesktopUser <user> [-Mode remote] # نسخ إلى ProgramData\OZK\CashierReprint\app + اختصار
powershell -File set-sql-secret.ps1 -User <user> -FromManualA4Print   # نسخ سرّ حساب القراءة من أداة A4 على الجهاز نفسه
powershell -File app\cashier-reprint.ps1 -Mode Health          # فحص بلا طباعة: الجسر والطابعة والاتصال
```

للوضع البعيد على OZK2026 يلزم بعد ذلك، وكلها بموافقة:
- مفتاح ed25519 بلا عبارة مرور في `keys\` (قراءة LOQ وحده).
- `known_hosts` ببصمة OZKUSER بعد مطابقتها يدوياً.
- سطر الأمر المفروض أعلاه على OZKUSER.
- لا سرّ SQL على OZK2026 في هذا الوضع.

الإزالة: `install.ps1 -DesktopUser <user> -Remove`، ثم حذف `C:\ProgramData\OZK\CashierReprint` عند الحاجة.

## الاختبار

`tools/tests/Test-CashierReprint.ps1` (Windows PowerShell 5.1 في CI، وPowerShell 7 محلياً). بلا أمين
ولا طابعة: صفوف مصطنعة وجسر وهمي.
