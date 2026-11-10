-- ============================================================================
-- 29: تحرير حجز إشعار واحد بعينه (job_id + token هذا الحجز) — إصلاح عطل جزئي في الحجز.
--
-- الحالة: مقترحة، غير مطبَّقة. التطبيق بموافقة صريحة من المالك فقط، وقبل نشر نسخة
-- document-archive-notify التي تستدعي هذه الدالة.
-- التراجع: 29-document-archive-notify-release-claim-rollback.sql.
--
-- الثغرة التي تُغلقها: handleNotifyBatch يحجز دفعة مهام بالتتابع (26). إن نجح حجز بعض المهام
-- ثم فشل حجز مهمة لاحقة (عطل عابر)، كانت الدالة السابقة تُرجع 502 فوراً بلا أي تحرير، فتبقى
-- الحجوزات الناجحة سابقاً sending بلا أي محاولة إرسال حتى تنتهي مهلتها وتتحول unknown بـ26 —
-- تنبيه مالك وتعقيد يدوي لعطل كان يمكن تفاديه بإعادة محاولة بسيطة.
--
-- الإصلاح: بعد فشل حجز مهمة في وسط دفعة، تُحرَّر فوراً كل الحجوزات الناجحة من هذه الدفعة
-- بعينها (بـjob_id وtoken كل حجز) لتُعاد محاولتها بأمان، لا أن تُترك معلّقة بلا أي إرسال أبداً.
--
-- الأمان (القاعدة نفسها بالضبط كـ document_archive_finish_notification):
--   * التحرير محصور بـ job_id = X and claim_token = Y and state = 'sending' فقط.
--   * لا يمسّ حجزاً انتقل إلى حالة أخرى أصلاً (anan تزامن: محاولة أخرى أعادت حجزه بـtoken جديد
--     ⇒ 0 صف)، ولا حجزاً انتهت مهلته وتحوّل unknown (انتهاء صلاحية: 0 صف أيضاً) — فلا يُحرَّر
--     أبداً شيء بلغ unknown، ولا يُعاد إرساله تلقائياً مهما حدث؛ يبقى بانتظار المالك كما صمَّمت 26.
--   * ليست دالة تحرير عامة غير محصورة بهوية الطالب: محصورة تماماً بـtoken الحجز الذي أنشأه
--     المستدعي نفسه في هذا الطلب بعينه — بخلاف document_archive_release_notification_claims
--     الجماعية (لا تمسّ إلا unknown، ولا تُحصَر بtoken، فهي غير صالحة لهذا الغرض أبداً).
--
-- لا تغيّر 26 ولا تمسّها: دالة شقيقة جديدة فقط، فلا تعطّل أي شيء مُختبَر سابقاً.
-- ============================================================================

begin;

create or replace function public.document_archive_release_notification_claim(p_job_id text, p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows int;
begin
  update public.document_archive_notify_claims
     set state = 'released', resolved_at = now(), last_error = 'claim_batch_partial_failure'
   where job_id = p_job_id and claim_token = p_token and state = 'sending';
  get diagnostics v_rows = row_count;
  return jsonb_build_object('released', v_rows = 1);
end;
$$;

revoke all on function public.document_archive_release_notification_claim(text, uuid) from public, anon, authenticated;
grant execute on function public.document_archive_release_notification_claim(text, uuid) to service_role;

commit;
