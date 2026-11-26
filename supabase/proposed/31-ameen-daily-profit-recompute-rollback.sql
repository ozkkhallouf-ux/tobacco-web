-- تراجع Migration 31.
-- يعيد أولاً كل يوم غيّرته إعادة الاحتساب إلى ملخصه السابق، ويحذف الأيام التي
-- أُدرجت (من سجل private.ameen_daily_profit_revisions)، ثم يحذف الدوال والجدول.
-- النتيجة: صفوف ameen_daily_profit كما كانت قبل أول تشغيل لإعادة الاحتساب،
-- عدا ما كتبته مزامنة اليوم (upsert_ameen_daily_profit) بعد ذلك، فهو لا يُمسّ.
--
-- قبل تشغيله أوقف مهمتي إعادة الاحتساب على Windows، وإلا أعادتا الكتابة.

begin;

do $$ begin
  if to_regclass('private.ameen_daily_profit_revisions') is null then
    raise exception 'migration 31 rollback guard: not applied';
  end if;
end $$;

select private.ameen_daily_profit_revert_revisions('-infinity'::timestamptz) as reverted_revisions;

drop function public.recompute_ameen_daily_profit(date, jsonb);
drop function private.ameen_daily_profit_revert_revisions(timestamptz);
drop function private.ameen_daily_profit_financial(jsonb);
drop table private.ameen_daily_profit_revisions;

commit;
