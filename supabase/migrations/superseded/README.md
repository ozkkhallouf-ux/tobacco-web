# Superseded Migrations

هذه الملفات مسوَّدات كُتبت محلياً ولم تُطبَّق أبداً على قاعدة البيانات الحية.
كلٌّ منها استُبدل بنسخة مُحدَّثة طُبِّقت مباشرةً عبر SQL Editor بـtimestamp مختلف.

**قاعدة صارمة: لا تُنقَل هذه الملفات إلى المجلد الأب `migrations/` —
سيحاول Supabase CLI تطبيقها وستتعارض مع ما هو موجود فعلاً على الإنتاج.**

## جدول الاستبدال

| الملف المحلي (لم يُطبَّق) | Timestamp الإنتاجي المقابل | ملف التسوية في المجلد الأب | ما الذي تغيَّر |
|---|---|---|---|
| `20260823084956_smart_inventory_counter_isolation.sql` | `20260823085423` | `../20260823085423_smart_inventory_counter_isolation.sql` † | تعديل على منطق عزل العدادات في الجلسات |
| `20260826094640_fix_ameen_read_requests_initplan_current_setting.sql` | `20260826104745` + `20260826133200` | `../20260826104745_...sql` + `../20260826133200_...sql` † | تحسين أداء الاستعلام بفصل إصلاح initplan |
| `20260830140000_khalil_audit_log.sql` | `20260830141802` (`khalil_audit_log`) | `../20260830141802_khalil_audit_log.sql` †† | مسودة محلية لإنشاء جداول الـaudit وتعريف الدوال؛ لم يُثبت تطابقها مع محتوى الـmigration المطبَّق فعلياً على production |
| `20260830144330_expense_entries_owner_only_rls.sql` | `20260830172655` (`expense_entries_owner_only_rls`) | `../20260830172655_expense_entries_owner_only_rls.sql` † | تعديل في تعريف سياسة RLS للمصروفات |
| `20260831051500_fix_inventory_recon_match_key_fallbacks.sql` | `20260831020850` | `../20260831020850_fix_inventory_recon_match_key_fallbacks.sql` † | تطبيق على الإنتاج قبل الـcommit المحلي |
| `20260831120000_telegram_delivery_observability.sql` | `20260831185634` | `../20260831185634_telegram_delivery_observability.sql` † | إضافة `net_request_id` بنسخة مُصحَّحة |

\* **تصحيح (2026-09-14):** الإدخال السابق لسطر khalil audit كان خاطئاً — كان يشير إلى
`20260830134123` (وهذه في الواقع `harden_upsert_ameen_daily_profit_grants`، لا علاقة
لها بـkhalil audit). الـmigration الحي الصحيح المرتبط فعلياً بإنشاء **الجداول الأساسية**
لـkhalil audit (`khalil_audit_events`, `khalil_audit_cursor`) على الإنتاج هو
`20260830141802` باسم `khalil_audit_log` (مؤكَّد عبر `supabase migration list` واسم
الـmigration نفسه) — **وليس** كل جداول khalil_audit_* الأربعة: `khalil_audit_sync_heartbeat`
و`khalil_audit_notify_failures` أُضيفا لاحقاً وبشكل مستقل حسب تاريخ git المحلي (commits
`bf3e26d` و`77e9f47` على التوالي)، ولا يوجد إثبات أنهما جزء من نفس migration
`20260830141802` — انظر التوثيق الكامل في ملف reconciliation أدناه. **مهم:** لا يوجد
إثبات أن محتوى SQL الفعلي لهذا الـmigration مطابق حرفياً لمسودة
`20260830140000_khalil_audit_log.sql` المحلية — هذه المسودة مجرد نسخة محلية لم تُطبَّق
قط ولا تُعتبر نسخة تاريخية مثبتة من الـmigration الحي. الغرض من هذا الجدول هو تتبّع أي
timestamp إنتاجي يقابل أي محاولة محلية تقريبياً بالوقت، وليس إثبات تطابق المحتوى.

† **placeholder تسوية سجل (2026-09-15):** ملف في المجلد الأب يطابق طابع الإنتاج
(واسم تقريبي من المسودة المحلية حيث لم يُؤكَّد الاسم الحي). محتوى **تحقق أو تخطٍّ**
(verify-or-skip) لمعلم (landmark) — **لا** ينقل مسودة `superseded/` ولا يعيد
تشغيل DDL غير مُثبت ولا يخترع مخططاً. إن وُجد المعلم: NOTICE تحقق. إن غاب
(قاعدة فارغة / مسار ميزة خارج سلسلة المهاجرات النشطة): NOTICE no-op بلا
استثناء حتى لا تُجهض إعادة التشغيل عند طابع remote-only / قبل الوصول إلى
bootstrap الـaudit `20260830141802` (Codex P1 على PR #228). **هذا ليس ادّعاء
إعادة تشغيل مستقلة كاملة لكل جداول المنتج** (الأسعار/التكاليف/المصادر تبقى
خارج السلسلة أو تُوفَّر جزئياً كـbaseline). على الإنتاج يبقى CLI متخطّياً لأن
الإصدار مسجَّل. أسماء الطوابع غير المؤكَّدة (`20260826133200` خصوصاً) يجب
مطابقتها مع `supabase migration list` وإعادة تسمية جزء الاسم فقط إن لزم
(الإبقاء على رقم الإصدار).

†† **أساس audit قابل لإعادة التشغيل (2026-09-15):** `../20260830141802_khalil_audit_log.sql`
ليس placeholder تحقق فقط. يوفّر DDL bootstrap لقاعدة فارغة مشتق من المسودة المحلية
**لهذا الطابع** عند الوصول إليه (مطلوب كي لا تُجهض إعادة التشغيل عند stamp الـaudit —
Codex P1). على الإنتاج: CLI يتخطّى الملف لأن الإصدار مسجَّل. إن شُغِّل يدوياً
والكائنات موجودة: الحارس يرفض إعادة التطبيق (history-safe). **لا يدّعي** تطابقاً
حرفياً مع SQL Editor الأصلي، **ولا** يدّعي أن `supabase/migrations/` وحدها تبني
منتجاً كاملاً بلا جداول خارج السلسلة. **لا تنقل** مسودة `superseded/` إلى الأب
كملف منفصل — الـbootstrap مضمَّن في ملف الإصدار الإنتاجي.
**مساعدات التفويض (Codex P1 لاحق، 2026-09-15):** على مسار القاعدة الفارغة يُنشأ
`public.is_owner()` من `supabase/owner-role-access.sql` قبل سياسة قراءة الأحداث.
`public.is_staff()` غير معرَّفة في سلسلة المهاجرات النشطة — سياسة SELECT للـheartbeat
تُؤجَّل بـNOTICE عند غيابها (RLS يبقى مانعاً للقراءة المباشرة)، ويُرخَّى تحقق
`20260902080000` لنفس الحالة كي لا تُجهض إعادة التشغيل النظيفة.

**أساس تيليغرام للإدراج (Codex P1 لاحق، 2026-09-15):** على مسار القاعدة الفارغة
يُنشأ `public.telegram_outbox` و`public.notify_telegram(text,text,text,int)` من
`supabase/telegram-notifications.sql` (الجدول + دالة الإدراج فقط، مع عمود
`reply_markup`) **قبل** trigger إشعار الـaudit وقبل المهاجرات اللاحقة التي
تُعدِّل `telegram_outbox` (مثل `20260914120000`). لا يُعاد هنا تعريف المُرسِل
ولا جدولة cron ولا triggers المجالات — تلك تبقى خارج سلسلة المهاجرات النشطة
أو في مهاجرات لاحقة. الإنتاج يملك النظام أصلاً ويتخطّى ملف الـbootstrap.

**أساس الأسعار / التكاليف قبل ALTER (Codex P1 لاحق، 2026-09-15):** المهاجرتان
`../20260827110254_add_item_guid_to_approved_price_items.sql` و
`../20260827110325_fix_item_costs_true_guid.sql` كانتا تجهضان إعادة التشغيل
النظيفة لأن `CREATE TABLE` لـ`approved_price_items` كان خارج السلسلة النشطة
فقط (`supabase/approved-prices-table.sql`)، ولا يوجد `CREATE TABLE` لـ`item_costs`
في المستودع أصلاً. الإصلاح: (1) `20260827110254` يوفّر الجدول من ملف الأساس
بـ`IF NOT EXISTS` ثم يضيف `item_guid` (سياسات `is_staff` مؤجَّلة عند غياب
المساعد)؛ (2) `20260827110325` يصبح verify-or-skip عند غياب `item_costs` —
**بلا اختراع DDL**. الإنتاج يتخطّى الملفين لأن الإصدارين مسجَّلان.

كذلك تم تصحيح إدخال `expense_entries_owner_only_rls` أعلاه: كان يشير خطأً إلى
`20260830144806` (وهذه `khalil_audit_notify_catch_query_canceled`)؛ الصحيح هو
`20260830172655`.

## التحقق

قاعدة البيانات الحية تملك الميزات الكاملة لكل هذه الملفات:
- `expense_entries.rowsecurity = true` ✓
- `telegram_outbox.net_request_id bigint` ✓
- `telegram_delivery_audit` function exists ✓
- `khalil_audit_events` + جميع الجداول المرتبطة ✓

التحقق الأخير عبر `supabase migration list`: 2026-09-02 (جدول الاستبدال أعلاه صُحِّح
لاحقاً بتاريخ 2026-09-14 بعد تدقيق أمني وجد مطابقتين خاطئتين — انظر الملاحظة أعلاه؛
انظر أيضاً `supabase/migrations/20260915140000_khalil_audit_migration_history_reconciliation.sql`
للتوثيق الكامل، بما فيه التصحيح الدقيق لنسبة كل جدول khalil_audit_* لمصدره).

## تحذير تشغيلي — ترتيب النشر / Operator deployment order

### 0) شرط مسبق — إغلاق كل remote-only المعروف قبل أي `db push`

**EN:** Production records several versions that historically had no matching local
file. `--include-all` only “Include[s] all migrations not found on remote history
table”
([supabase db push](https://supabase.com/docs/reference/cli/supabase-db-push));
it does **not** handle the inverse (remote version missing locally), and the CLI
still stops on that history mismatch. Every known remote-only stamp from the table
above now has a matching local file under `../`:

| version | local file | kind |
|---|---|---|
| `20260823085423` | `20260823085423_smart_inventory_counter_isolation.sql` | landmark verify-or-skip (fresh no-op) |
| `20260826104745` | `20260826104745_fix_ameen_read_requests_initplan_current_setting.sql` | landmark verify-or-skip (fresh no-op) |
| `20260826133200` | `20260826133200_fix_ameen_read_requests_initplan_followup.sql` | landmark verify-or-skip (name unconfirmed) |
| `20260830141802` | `20260830141802_khalil_audit_log.sql` | fresh-DB bootstrap + refuse-if-present |
| `20260830172655` | `20260830172655_expense_entries_owner_only_rls.sql` | landmark verify-or-skip (fresh no-op) |
| `20260831020850` | `20260831020850_fix_inventory_recon_match_key_fallbacks.sql` | landmark verify-or-skip (fresh no-op) |
| `20260831185634` | `20260831185634_telegram_delivery_observability.sql` | landmark verify-or-skip (fresh no-op) |

Re-check with `supabase migration list` before Stage 2. If a **name** mismatch
appears for an unconfirmed stamp, rename only the name segment (keep the version).

**AR:** الإنتاج يسجّل عدة طوابع كانت بلا ملف محلي. العلم `--include-all` يعالج
المهاجرات المحلية الناقصة من السجل البعيد فقط، **ولا** يغلق الحالة العكسية
(طابع بعيد بلا ملف محلي). كل طابع remote-only معروف في الجدول أعلاه له الآن ملف
محلي مطابق تحت `../` (انظر الجدول الإنجليزي). راجع `supabase migration list`
قبل المرحلة ٢. عند اختلاف **الاسم** فقط لطابع غير مؤكَّد: أعد تسمية جزء الاسم
مع الإبقاء على رقم الإصدار.

### 1) بعد إغلاق remote-only — `--include-all` أو المرحلة ٢

**EN:** Production already records later stamps such as `20260914130000`. A plain
`supabase db push` will **not** apply the still-pending older migrations
`20260902050000_khalil_audit_tables_explicit_deny.sql` and
`20260902080000_p2_heartbeat_rls_initplan.sql` just because the 09-15 reconciliation
file sorts later. After step 0, when applying
`20260915140000_khalil_audit_migration_history_reconciliation.sql` to such a remote,
operators must either:

1. Apply the separately approved 09-02 migrations first (Stage 2 — explicit owner
   approval), **then** push this reconciliation; **or**
2. Use `supabase db push --include-all` so every migration missing from the remote
   history table is included.

**AR:** بعد الخطوة ٠: إذا كان الإنتاج يملك أصلاً طابعاً لاحقاً مثل
`20260914130000`، فإن `supabase db push` العادي **لن** يطبّق المهاجرات المعلّقة
الأقدم (`20260902050000` و`20260902080000`) لمجرد أن ملف التسوية `20260915140000`
يرتّب بعدهما. عند تطبيق ملف التسوية على بيئة بهذه الحالة، يجب إما:

1. تطبيق مهاجرات 09-02 المعتمدة بشكل منفصل أولاً (المرحلة ٢ — إذن صريح من المالك)،
   ثم دفع ملف التسوية؛ **أو**
2. استخدام `supabase db push --include-all` لإدراج كل المهاجرات غير الموجودة في
   سجل الإنتاج البعيد.

هذا التوثيق لا يصرّح بتطبيق أي شيء على الإنتاج — الدفع يبقى يدوياً وبإذن منفصل.
