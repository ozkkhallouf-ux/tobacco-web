# Superseded Migrations

هذه الملفات مسوَّدات كُتبت محلياً ولم تُطبَّق أبداً على قاعدة البيانات الحية.
كلٌّ منها استُبدل بنسخة مُحدَّثة طُبِّقت مباشرةً عبر SQL Editor بـtimestamp مختلف.

**قاعدة صارمة: لا تُنقَل هذه الملفات إلى المجلد الأب `migrations/` —
سيحاول Supabase CLI تطبيقها وستتعارض مع ما هو موجود فعلاً على الإنتاج.**

## جدول الاستبدال

| الملف المحلي (لم يُطبَّق) | Timestamp الإنتاجي المقابل | ما الذي تغيَّر |
|---|---|---|
| `20260823084956_smart_inventory_counter_isolation.sql` | `20260823085423` (بعده بـ4 دق.) | تعديل على منطق عزل العدادات في الجلسات |
| `20260826094640_fix_ameen_read_requests_initplan_current_setting.sql` | `20260826104745` + `20260826133200` | تحسين أداء الاستعلام بفصل إصلاح initplan |
| `20260830140000_khalil_audit_log.sql` | `20260830141802` (`khalil_audit_log`) — انظر ملاحظة* | مسودة محلية لإنشاء جداول الـaudit وتعريف الدوال؛ لم يُثبت تطابقها مع محتوى الـmigration المطبَّق فعلياً على production |
| `20260830144330_expense_entries_owner_only_rls.sql` | `20260830172655` (`expense_entries_owner_only_rls`) | تعديل في تعريف سياسة RLS للمصروفات |
| `20260831051500_fix_inventory_recon_match_key_fallbacks.sql` | `20260831020850` | تطبيق على الإنتاج قبل الـcommit المحلي |
| `20260831120000_telegram_delivery_observability.sql` | `20260831185634` | إضافة `net_request_id` بنسخة مُصحَّحة |

\* **تصحيح (2026-09-14):** الإدخال السابق لهذا السطر كان خاطئاً — كان يشير إلى
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
