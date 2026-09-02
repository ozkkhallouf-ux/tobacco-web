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
| `20260830140000_khalil_audit_log.sql` | `20260830134123` + 3 آخرين | إضافة جداول الـaudit وتعريف الدوال مرحلياً |
| `20260830144330_expense_entries_owner_only_rls.sql` | `20260830144806` | تعديل في تعريف سياسة RLS للمصروفات |
| `20260831051500_fix_inventory_recon_match_key_fallbacks.sql` | `20260831020850` | تطبيق على الإنتاج قبل الـcommit المحلي |
| `20260831120000_telegram_delivery_observability.sql` | `20260831185634` | إضافة `net_request_id` بنسخة مُصحَّحة |

## التحقق

قاعدة البيانات الحية تملك الميزات الكاملة لكل هذه الملفات:
- `expense_entries.rowsecurity = true` ✓
- `telegram_outbox.net_request_id bigint` ✓
- `telegram_delivery_audit` function exists ✓
- `khalil_audit_events` + جميع الجداول المرتبطة ✓

التحقق الأخير عبر `supabase migration list`: 2026-09-02
