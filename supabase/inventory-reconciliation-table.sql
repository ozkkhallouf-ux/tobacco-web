-- ============================================================
-- OZK TOBACCO — الجرد الشهري (تسوية المخزون) — مقترح مخطط فقط
-- ملف مرجعي غير مُطبَّق على أي قاعدة إنتاج بعد. لا تُشغّله على Supabase
-- إلا بعد مراجعة صريحة من صاحب الحساب (ozk.kh@outlook.com).
--
-- "تسجيلي فقط" (registration-only): اعتماد جلسة الجرد يقفل السجل فقط
-- (status='approved') ولا يغيّر أي مخزون أو حساب في الأمين أو Supabase.
-- انظر tools/push-inventory-reconciliation-to-ameen.ps1 (stub مقفل).
--
-- ⚠️ ترتيب التطبيق: هذا الملف يعتمد الآن على وجود جدول
-- ameen_warehouse_stock_reports (مفتاح أجنبي source_report_id أدناه) —
-- يجب تطبيق supabase/ameen-warehouse-stock-reports.sql أولاً، ثم هذا الملف.
-- ============================================================

create table if not exists inventory_recon_sessions (
  id             uuid          default gen_random_uuid() primary key,
  session_date   date          not null default current_date,
  session_month  date          not null,
  warehouse_key  text          not null,
  warehouse_name text          not null,
  status         text          not null default 'draft' check (status in ('draft', 'reviewed', 'approved')),
  idempotency_key text         not null,
  source_report_id   uuid      references ameen_warehouse_stock_reports(id) on delete set null,
  source_report_date timestamptz,
  notes          text,
  created_by     uuid          references auth.users(id) on delete set null,
  created_at     timestamptz   default now(),
  updated_at     timestamptz   default now(),
  reviewed_at    timestamptz,
  reviewed_by    uuid          references auth.users(id) on delete set null,
  approved_at    timestamptz,
  approved_by    uuid          references auth.users(id) on delete set null,
  unique (created_by, idempotency_key)
);

comment on table inventory_recon_sessions is 'جلسات الجرد الشهري — تسجيل داخلي فقط، لا تُزامَن مع الأمين ولا تُغيّر مخزوناً';
comment on column inventory_recon_sessions.created_by is 'مالك المسودة — يُختم تلقائياً من auth.uid() عند الإنشاء ولا يمكن تعديله لاحقاً';
comment on column inventory_recon_sessions.reviewed_by is 'من راجع الجلسة (draft → reviewed) — يُختم من الخادم فقط';
comment on column inventory_recon_sessions.approved_by is 'من اعتمد الجلسة (reviewed → approved) — يُختم من الخادم فقط، وحصراً لحساب المالك';
comment on column inventory_recon_sessions.source_report_id is 'تقرير مخزون المستودع الموثوق من الجدول المستقل ameen_warehouse_stock_reports الذي استُخرجت منه كمية النظام وهوية الأصناف داخل RPC — بلا اعتماد على أي قيمة يرسلها المتصفح مباشرة. on delete set null لأن أرشفة/حذف تقرير قديم يجب ألا يكسر جلسة جرد تاريخية';
comment on column inventory_recon_sessions.source_report_date is 'تاريخ/وقت التقرير المصدر وقت إنشاء الجلسة — يُحفظ منفصلاً كي يبقى معروفاً حتى لو حُذف صف ameen_warehouse_stock_reports لاحقاً (source_report_id يصبح NULL بـon delete set null)';
comment on constraint inventory_recon_sessions_created_by_idempotency_key_key on inventory_recon_sessions is 'التفرد على (created_by, idempotency_key) لا على idempotency_key وحده — كان تفرداً عاماً يسمح نظرياً بأن يستلم مستخدم جلسة مستخدم آخر عند تصادم نصي للمفتاح';

-- ============================================================
-- مراجعة Codex على PR #40، commit 84b74de: بعد نقل تقرير المخزون إلى الجدول
-- المستقل ameen_warehouse_stock_reports، بقي هذا العمود بالإنتاج (إن كان
-- الجدول قد أُنشئ سابقاً بالصيغة القديمة) يشير بمفتاح أجنبي إلى
-- inventory_reports(id) — وهذا يفشل أي إدراج جلسة جديدة لأن RPC الآن يقرأ
-- p_source_report_id من ameen_warehouse_stock_reports، لا من inventory_reports،
-- فلن يتطابق مع الـFK القديم إلا مصادفة (لو تشابه UUID بين الجدولين، احتمال
-- شبه معدوم لكنه غير آمن منطقياً بحال حدث). الترحيل التالي آمن لإعادة
-- التطبيق (idempotent) على قاعدة جديدة أو قديمة على حد سواء:
--   1) يصفّر source_report_id لأي جلسة قديمة تشير إلى صف لم يعد موجوداً
--      بالجدول الجديد (تاريخي فقط — source_report_date يبقى محفوظاً كما هو،
--      ولا يُحذف أي سطر جرد ولا تُفقد أي بيانات جلسة).
--   2) يسقط الـFK القديم (أياً كان اسمه الفعلي بقاعدة الإنتاج) ثم يضيف FK
--      جديداً صريحاً يشير إلى ameen_warehouse_stock_reports(id).
-- لا يعتمد على اسم قيد معيّن: يبحث في information_schema عن أي FK فعلي على
-- هذا العمود ويسقطه ديناميكياً قبل إضافة القيد الجديد.
-- ============================================================

do $$
declare
  fk_name text;
begin
  update inventory_recon_sessions
  set source_report_id = null
  where source_report_id is not null
    and not exists (
      select 1 from ameen_warehouse_stock_reports r where r.id = inventory_recon_sessions.source_report_id
    );

  for fk_name in
    select tc.constraint_name
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_name = tc.constraint_name
     and kcu.table_schema = tc.table_schema
    where tc.table_schema = 'public'
      and tc.table_name = 'inventory_recon_sessions'
      and tc.constraint_type = 'FOREIGN KEY'
      and kcu.column_name = 'source_report_id'
  loop
    execute format('alter table inventory_recon_sessions drop constraint %I', fk_name);
  end loop;

  alter table inventory_recon_sessions
    add constraint inventory_recon_sessions_source_report_id_fkey
    foreign key (source_report_id) references ameen_warehouse_stock_reports(id) on delete set null;
end;
$$;

create table if not exists inventory_recon_lines (
  id               uuid          default gen_random_uuid() primary key,
  session_id       uuid          not null references inventory_recon_sessions(id) on delete cascade,
  item_key         text          not null check (trim(item_key) <> ''),
  item_number      text,
  item_name        text          not null check (trim(item_name) <> ''),
  unit_name        text,
  system_qty       numeric(18,3) not null default 0,
  actual_qty       numeric(18,3) check (actual_qty is null or actual_qty >= 0),
  diff_qty         numeric(18,3) generated always as (
                     case when actual_qty is null then null else actual_qty - system_qty end
                   ) stored,
  unit_cost        numeric(18,4) check (unit_cost is null or unit_cost >= 0),
  currency         text          check (currency is null or currency in ('USD', 'SYP')),
  settlement_value numeric(18,2) generated always as (
                     case when actual_qty is null or unit_cost is null then null else (actual_qty - system_qty) * unit_cost end
                   ) stored,
  reason           text,
  created_at       timestamptz   default now(),
  updated_at       timestamptz   default now(),
  unique (session_id, item_key)
);

comment on table inventory_recon_lines is 'سطور الجرد لكل صنف — الفرق والقيمة تقديريان لأغراض العرض والتقرير فقط، لا يُنشأ منهما أي قيد محاسبي';
comment on constraint inventory_recon_lines_item_key_check on inventory_recon_lines is 'يمنع مفتاح صنف فارغ/مسافات فقط — حماية على مستوى القاعدة بعد أن كان not null وحده يسمح بقيمة نصية فارغة';
comment on constraint inventory_recon_lines_item_name_check on inventory_recon_lines is 'يمنع اسم صنف فارغ/مسافات فقط لنفس السبب';
comment on constraint inventory_recon_lines_actual_qty_check on inventory_recon_lines is 'يمنع كمية فعلية سالبة — دفاع مستوى قاعدة بيانات مستقل عن أي تحقق في الواجهة';
comment on constraint inventory_recon_lines_unit_cost_check on inventory_recon_lines is 'يمنع تكلفة وحدة سالبة لنفس السبب';
comment on constraint inventory_recon_lines_currency_check on inventory_recon_lines is 'قائمة العملات المسموحة USD/SYP فقط أو NULL إن لم تُعرف تكلفة موثوقة للصنف بعد — لا افتراض ضمني لعملة بلا تكلفة فعلية';
comment on column inventory_recon_lines.unit_cost is 'تكلفة الوحدة من item_costs عبر item_guid ثم match_key (كود/اسم) — تبقى NULL إن لم توجد تكلفة موثوقة، ولا تُصفَّر أبداً كي لا يظهر settlement_value=0 مضلِّلاً';
comment on column inventory_recon_lines.settlement_value is 'قيمة تقديرية = (الفعلي - النظام) × التكلفة — تبقى NULL صراحة إن لم تُجرَد الكمية الفعلية بعد أو لم تُعرف تكلفة الصنف، بدل صفر مضلِّل';

-- session_id/line_id بلا foreign key عمداً: سجل التدقيق يجب أن يبقى دائماً
-- حتى بعد حذف الجلسة/السطر التي يوثّقها. لو كانا مرتبطين بـFK فسيفشل DELETE
-- (الـtrigger يحاول إدخال سطر تدقيق بعد الحذف يشير لصف لم يعد موجوداً)، وأي
-- FK بـon delete cascade كان سيمحو تاريخ التدقيق نفسه عند حذف الجلسة — وهذا
-- يناقض الغرض من وجود سجل تدقيق دائم. المعرّف الكامل محفوظ أيضاً داخل
-- before_data/after_data (to_jsonb) لمن يحتاج لقراءته بعد حذف الصف الأصلي.
create table if not exists inventory_recon_audit_log (
  id          bigint generated always as identity primary key,
  session_id  uuid,
  line_id     uuid,
  actor       text,
  action      text not null,
  before_data jsonb,
  after_data  jsonb,
  created_at  timestamptz default now()
);

comment on table inventory_recon_audit_log is 'سجل تدقيق لتغييرات جلسات وسطور الجرد — يُملأ حصراً من triggers، لا يقبل إدخالاً مباشراً من العميل، ويبقى بعد حذف الجلسة/السطر (بلا FK) لأنه سجل تاريخي دائم';
comment on column inventory_recon_audit_log.session_id is 'معرف الجلسة وقت الحدث — بلا FK عمداً كي لا يُحذف سجل التدقيق مع الجلسة';
comment on column inventory_recon_audit_log.line_id is 'معرف السطر وقت الحدث — بلا FK عمداً لنفس السبب';

-- إعادة تطبيق آمنة: تعبير العمود المولَّد settlement_value لا يمكن تعديله
-- بـALTER COLUMN مباشرة في PostgreSQL — لو كان هذا الملف قد طُبِّق سابقاً
-- بالصيغة القديمة (تُصفِّر unit_cost المفقود بدل NULL)، نعيد إنشاء العمود
-- بالتعريف الصحيح. آمن أيضاً على قاعدة جديدة (لا يوجد عمود ليُحذف).
alter table inventory_recon_lines drop column if exists settlement_value;
alter table inventory_recon_lines add column settlement_value numeric(18,2) generated always as (
  case when actual_qty is null or unit_cost is null then null else (actual_qty - system_qty) * unit_cost end
) stored;

create index if not exists idx_inventory_recon_sessions_date
  on inventory_recon_sessions (session_date desc);

create index if not exists idx_inventory_recon_sessions_month_warehouse
  on inventory_recon_sessions (session_month, warehouse_key);

create index if not exists idx_inventory_recon_sessions_source_report
  on inventory_recon_sessions (source_report_id);

create index if not exists idx_inventory_recon_sessions_reviewed_by
  on inventory_recon_sessions (reviewed_by);

create index if not exists idx_inventory_recon_sessions_approved_by
  on inventory_recon_sessions (approved_by);

create index if not exists idx_inventory_recon_lines_session
  on inventory_recon_lines (session_id);

create index if not exists idx_inventory_recon_audit_log_session
  on inventory_recon_audit_log (session_id);

-- ============================================================
-- دالة المالك تعتمد app_metadata التي لا يستطيع المستخدم تعديلها بنفسه.
-- سطر ~498 (نفس القائمة المستعملة لبوابات واجهة أخرى مثل item_costs).
-- بلا SECURITY DEFINER: تقرأ فقط auth.jwt() الخاص بالجلسة الحالية.
-- ============================================================

create or replace function inventory_recon_is_owner()
returns boolean
language sql
stable
set search_path = public
as $$
  select lower(coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '')) = 'owner';
$$;

-- ============================================================
-- مراجعة Codex على PR #40: source='ameen_warehouse_stock' وحده لا يكفي —
-- أي موظف مسجَّل يملك صلاحية INSERT على inventory_reports (الجدول
-- المشترك مع تقارير أخرى كثيرة) كان يستطيع نظرياً إدراج صف بنفس المصدر
-- وبيانات مصطنعة. الجولة الثانية من المراجعة (بعد نقل هذا التقرير إلى
-- جدول ameen_warehouse_stock_reports المستقل بسياسة INSERT محصورة —
-- supabase/ameen-warehouse-stock-reports.sql): هذه الدالة تبقى كطبقة
-- دفاع مضاعفة تتحقق من created_by بالـUUID الثابت نفسه المستخدم في سياسة
-- ameen_warehouse_stock_reports. لا يوجد placeholder أو اعتماد على البريد.
-- ============================================================

create or replace function inventory_recon_warehouse_stock_report_is_trusted(p_created_by uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select p_created_by = '9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3'::uuid;
$$;

comment on function inventory_recon_warehouse_stock_report_is_trusted(uuid) is 'دفاع مضاعف: يتحقق أن created_by المخزَّن بصف ameen_warehouse_stock_reports يطابق UUID حساب المزامنة الموثوق نفسه المستخدم في سياسة INSERT.';

revoke all on function inventory_recon_warehouse_stock_report_is_trusted(uuid) from public;
grant execute on function inventory_recon_warehouse_stock_report_is_trusted(uuid) to authenticated;

-- ============================================================
-- حارس الثبات + الختم: يمنع أي تعديل بعد status='approved'، يقفل
-- created_by ضد الانتحال، يختم reviewed_by/approved_by من الخادم حصراً
-- عند الانتقال الفعلي فقط، ويمنع الاعتماد قبل اكتمال كل سطر (كمية فعلية
-- + سبب) لأي فرق غير صفري.
-- (نفس فكرة purchase_invoice_guard_immutable_and_stamp في
-- purchase-invoices-ameen-sync.sql)
-- ============================================================

create or replace function inventory_recon_guard_immutable()
returns trigger as $$
declare
  status_rank constant jsonb := '{"draft": 0, "reviewed": 1, "approved": 2}';
  old_rank int;
  new_rank int;
  incomplete_count int;
begin
  if OLD.status = 'approved' then
    raise exception 'inventory_recon_sessions: session % is approved and cannot be modified or deleted', OLD.id;
  end if;

  if TG_OP = 'DELETE' then
    return OLD;
  end if;

  if NEW.created_by is distinct from OLD.created_by then
    raise exception 'inventory_recon_sessions: created_by لا يمكن تعديله بعد الإنشاء';
  end if;

  if NEW.status is distinct from OLD.status then
    old_rank := (status_rank ->> OLD.status)::int;
    new_rank := (status_rank ->> NEW.status)::int;
    if new_rank is null or new_rank <> old_rank + 1 then
      raise exception 'inventory_recon_sessions: invalid status transition % -> % for session %', OLD.status, NEW.status, OLD.id;
    end if;

    if OLD.status = 'draft' and NEW.status = 'reviewed' then
      -- دفاع مستقل عن inventory_recon_set_status: التحقق مكرَّر عمداً هنا
      -- لأن هذه الدالة SECURITY DEFINER وتعمل بصلاحيات مالكها بغض النظر عن
      -- المستدعي، فيجب ألا تعتمد وحدها على أن الـRPC هو المسار الوحيد.
      if not (OLD.created_by = auth.uid() or public.inventory_recon_is_owner()) then
        raise exception 'inventory_recon_sessions: مراجعة الجلسة محصورة بمنشئ المسودة أو المالك';
      end if;
      NEW.reviewed_by := auth.uid();
      NEW.reviewed_at := now();
    elsif OLD.status = 'reviewed' and NEW.status = 'approved' then
      if not public.inventory_recon_is_owner() then
        raise exception 'inventory_recon_sessions: اعتماد الجلسة محصور بحساب المالك';
      end if;

      if not exists (select 1 from public.inventory_recon_lines where session_id = OLD.id) then
        raise exception 'inventory_recon_sessions: لا يمكن اعتماد جلسة بلا أي سطر';
      end if;

      select count(*) into incomplete_count
      from public.inventory_recon_lines
      where session_id = OLD.id
        and diff_qty is distinct from 0
        and (actual_qty is null or reason is null or trim(reason) = '' or unit_cost is null);
      if incomplete_count > 0 then
        raise exception 'inventory_recon_sessions: % سطر بلا كمية فعلية أو سبب أو تكلفة معروفة لفرق غير صفري — لا يمكن الاعتماد قبل أن يراجع المالك التكلفة', incomplete_count;
      end if;

      NEW.approved_by := auth.uid();
      NEW.approved_at := now();
    end if;
  else
    if NEW.reviewed_by is distinct from OLD.reviewed_by or NEW.reviewed_at is distinct from OLD.reviewed_at then
      raise exception 'inventory_recon_sessions: reviewed_by/reviewed_at لا يمكن تعديلهما إلا عند انتقال draft→reviewed نفسه';
    end if;
    if NEW.approved_by is distinct from OLD.approved_by or NEW.approved_at is distinct from OLD.approved_at then
      raise exception 'inventory_recon_sessions: approved_by/approved_at لا يمكن تعديلهما إلا عند انتقال reviewed→approved نفسه';
    end if;
  end if;

  return NEW;
end;
$$ language plpgsql set search_path = '';

drop trigger if exists trg_inventory_recon_guard_session on inventory_recon_sessions;
create trigger trg_inventory_recon_guard_session
  before update or delete on inventory_recon_sessions
  for each row
  execute function inventory_recon_guard_immutable();

create or replace function inventory_recon_guard_lines_immutable()
returns trigger as $$
declare
  session_status text;
begin
  select status into session_status
  from public.inventory_recon_sessions
  where id = coalesce(NEW.session_id, OLD.session_id);

  -- عند ON DELETE CASCADE تكون الجلسة الأم قد اختفت قبل تشغيل trigger حذف
  -- السطر، فيرجع الاستعلام NULL. هذا هو مسار الحذف المتسلسل المشروع الوحيد؛
  -- أما UPDATE/INSERT أو حذف مباشر لسطر فتبقى الجلسة موجودة ويُطبق قفل draft.
  if TG_OP = 'DELETE' and session_status is null then
    return OLD;
  end if;

  if session_status is distinct from 'draft' then
    raise exception 'inventory_recon_lines: parent session % is not a draft (status=%) — its lines are locked', coalesce(NEW.session_id, OLD.session_id), session_status;
  end if;

  return coalesce(NEW, OLD);
end;
$$ language plpgsql set search_path = '';

drop trigger if exists trg_inventory_recon_guard_lines on inventory_recon_lines;
create trigger trg_inventory_recon_guard_lines
  before insert or update or delete on inventory_recon_lines
  for each row
  execute function inventory_recon_guard_lines_immutable();

-- ============================================================
-- سجل التدقيق: يُملأ حصراً من trigger عبر دالة SECURITY DEFINER
-- (تعمل بصلاحيات مالك الدالة فتتجاوز RLS)، لا إدخال مباشر من العميل.
--
-- الدالة منقولة إلى مخطط private (لا public): PostgREST/Data API لا يُعرِّض
-- إلا الدوال في الـschema المُعرَّف بـ"exposed schemas" (public افتراضياً)،
-- فوضعها خارج public يمنعها من الأساس من الظهور كـRPC قابل للاستدعاء من
-- العميل — طبقة حماية أقوى من revoke execute وحدها (وهي مُبقاة أيضاً هنا
-- كدفاع مضاعف على مستوى الدور، لأن أي اتصال SQL مباشر بصلاحيات كافية ما زال
-- يستطيع رؤية الدالة عبر تأهيل الاسم الكامل). الـtriggers تستدعيها بالاسم
-- الكامل private.inventory_recon_write_audit_log() فتستمر بالعمل بلا تغيير.
-- ============================================================

create schema if not exists private;

create or replace function private.inventory_recon_write_audit_log()
returns trigger as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_row jsonb;
begin
  -- NEW/OLD من نوع record ديناميكي؛ لا يجوز الوصول مباشرة إلى حقل session_id
  -- لأن trigger الجلسات لا يملك هذا الحقل أصلاً، وPostgreSQL يرفع خطأ حتى لو
  -- كان فرع CASE الآخر هو المختار. نحول السجل إلى JSONB أولاً ثم نقرأ المفاتيح
  -- الموجودة فعلياً حسب الجدول، فيعمل trigger نفسه للجلسات والسطور معاً.
  v_before := case when TG_OP = 'INSERT' then null else to_jsonb(OLD) end;
  v_after := case when TG_OP = 'DELETE' then null else to_jsonb(NEW) end;
  v_row := coalesce(v_after, v_before);

  insert into public.inventory_recon_audit_log(session_id, line_id, actor, action, before_data, after_data)
  values (
    case when TG_TABLE_NAME = 'inventory_recon_sessions' then (v_row ->> 'id')::uuid
         else (v_row ->> 'session_id')::uuid end,
    case when TG_TABLE_NAME = 'inventory_recon_lines' then (v_row ->> 'id')::uuid else null end,
    auth.uid()::text,
    TG_OP,
    v_before,
    v_after
  );
  return coalesce(NEW, OLD);
end;
$$ language plpgsql security definer set search_path = '';

-- SECURITY DEFINER تعمل بصلاحيات مالكها بغض النظر عن EXECUTE — لا يحتاجها
-- العميل عبر RPC مباشر (يُستدعى فقط من الـtriggers)، فنسحب الصلاحية الافتراضية
-- من public/anon/authenticated لتضييق سطح الهجوم كدفاع إضافي رغم أنها لم تعد
-- في schema معروض أصلاً.
revoke execute on function private.inventory_recon_write_audit_log() from public;
revoke execute on function private.inventory_recon_write_audit_log() from anon, authenticated;

drop trigger if exists trg_inventory_recon_audit_sessions on inventory_recon_sessions;
create trigger trg_inventory_recon_audit_sessions
  after insert or update or delete on inventory_recon_sessions
  for each row
  execute function private.inventory_recon_write_audit_log();

drop trigger if exists trg_inventory_recon_audit_lines on inventory_recon_lines;
create trigger trg_inventory_recon_audit_lines
  after insert or update or delete on inventory_recon_lines
  for each row
  execute function private.inventory_recon_write_audit_log();

-- ============================================================
-- RLS — القراءة متاحة لكل مستخدم authenticated، والتعديل/الاعتماد
-- محصوران بمنشئ الجلسة (مسودته فقط) أو حساب المالك.
-- ============================================================

alter table inventory_recon_sessions enable row level security;
alter table inventory_recon_lines enable row level security;
alter table inventory_recon_audit_log enable row level security;

-- كل policy تُسبَق بـdrop policy if exists كي يبقى الملف قابلاً لإعادة
-- التشغيل بأمان على قاعدة طُبِّق عليها إصدار سابق منه (create policy وحدها
-- تفشل بخطأ "already exists" عند إعادة التشغيل، بخلاف create or replace).

drop policy if exists "inventory_recon_sessions_select" on inventory_recon_sessions;
create policy "inventory_recon_sessions_select"
  on inventory_recon_sessions for select
  to authenticated
  using (true);

drop policy if exists "inventory_recon_sessions_insert" on inventory_recon_sessions;
create policy "inventory_recon_sessions_insert"
  on inventory_recon_sessions for insert
  to authenticated
  with check (created_by = (select auth.uid()));

drop policy if exists "inventory_recon_sessions_update" on inventory_recon_sessions;
create policy "inventory_recon_sessions_update"
  on inventory_recon_sessions for update
  to authenticated
  using (
    status <> 'approved'
    and (created_by = (select auth.uid()) or (select inventory_recon_is_owner()))
  )
  with check (
    (select inventory_recon_is_owner())
    or (created_by = (select auth.uid()) and status in ('draft', 'reviewed'))
  );

drop policy if exists "inventory_recon_sessions_delete" on inventory_recon_sessions;
create policy "inventory_recon_sessions_delete"
  on inventory_recon_sessions for delete
  to authenticated
  using (
    status <> 'approved'
    and (
      (status = 'draft' and created_by = (select auth.uid()))
      or (select inventory_recon_is_owner())
    )
  );

-- القراءة المباشرة من الجدول محصورة بالمالك فقط: unit_cost/currency/
-- settlement_value بيانات تكلفة حسّاسة (item_costs نفسه "محمي — يقرأه المدير
-- فقط" حسب tools/push-item-costs.ps1)، وusing(true) السابقة كانت تعرض هذه
-- الأعمدة لأي مستخدم authenticated عبر أي جلسة، ليس فقط جلسته. كل قراءة غير
-- المالك يجب أن تمر عبر inventory_recon_lines_for_session() أدناه، التي
-- تُخفي هذه الأعمدة صراحةً بدل الاعتماد على أن الواجهة فقط لا تعرضها.
drop policy if exists "inventory_recon_lines_select" on inventory_recon_lines;
create policy "inventory_recon_lines_select"
  on inventory_recon_lines for select
  to authenticated
  using ((select inventory_recon_is_owner()));

-- لا تستخدم FOR ALL هنا: سياسات RLS permissive تُجمع بـOR، وFOR ALL يضيف
-- ضمنياً سياسة SELECT تسمح لمنشئ المسودة بقراءة unit_cost/currency الخام
-- متجاوزاً inventory_recon_lines_select المقنَّعة أعلاه. نفصل عمليات الكتابة
-- الثلاث كي تبقى القراءة المباشرة للمالك فقط.
drop policy if exists "inventory_recon_lines_write" on inventory_recon_lines;
drop policy if exists "inventory_recon_lines_insert" on inventory_recon_lines;
create policy "inventory_recon_lines_insert"
  on inventory_recon_lines for insert
  to authenticated
  with check (
    exists (
      select 1 from inventory_recon_sessions s
      where s.id = inventory_recon_lines.session_id
        and s.status = 'draft'
        and (s.created_by = (select auth.uid()) or (select inventory_recon_is_owner()))
    )
  );

drop policy if exists "inventory_recon_lines_update" on inventory_recon_lines;
create policy "inventory_recon_lines_update"
  on inventory_recon_lines for update
  to authenticated
  using (
    exists (
      select 1 from inventory_recon_sessions s
      where s.id = inventory_recon_lines.session_id
        and s.status = 'draft'
        and (s.created_by = (select auth.uid()) or (select inventory_recon_is_owner()))
    )
  )
  with check (
    exists (
      select 1 from inventory_recon_sessions s
      where s.id = inventory_recon_lines.session_id
        and s.status = 'draft'
        and (s.created_by = (select auth.uid()) or (select inventory_recon_is_owner()))
    )
  );

drop policy if exists "inventory_recon_lines_delete" on inventory_recon_lines;
create policy "inventory_recon_lines_delete"
  on inventory_recon_lines for delete
  to authenticated
  using (
    exists (
      select 1 from inventory_recon_sessions s
      where s.id = inventory_recon_lines.session_id
        and s.status = 'draft'
        and (s.created_by = (select auth.uid()) or (select inventory_recon_is_owner()))
    )
  );

-- سجل التدقيق يحفظ نسخة كاملة من السطر (before_data/after_data عبر to_jsonb(NEW))
-- بما فيها unit_cost/currency/settlement_value — نفس الأعمدة الممنوعة على غير
-- المالك في inventory_recon_lines_select. لذلك لا يجوز using(true) هنا؛ قراءة
-- سجل التدقيق تبقى حكراً على المالك مثل قراءة السطور الخام مباشرة.
drop policy if exists "inventory_recon_audit_log_select" on inventory_recon_audit_log;
create policy "inventory_recon_audit_log_select"
  on inventory_recon_audit_log for select
  to authenticated
  using ((select inventory_recon_is_owner()));

-- ملاحظة: لا توجد policy إدخال/تعديل/حذف لـinventory_recon_audit_log —
-- الكتابة الوحيدة المسموحة تمر عبر inventory_recon_write_audit_log()
-- (SECURITY DEFINER)، فأي محاولة إدخال مباشر من العميل تُرفض تلقائياً.

-- ============================================================
-- GRANT صريحة — دفاع مستوى ثانٍ مستقل عن RLS، ونفس السبب العملي المذكور في
-- purchase-invoices-ameen-sync.sql: مشاريع Supabase الحديثة لا تُعرِّض الجداول
-- المُنشأة تلقائياً لـData API/PostgREST بدون GRANT صريحة لأي دور، حتى مع
-- RLS مفعّلة وصحيحة — فتفشل استدعاءات supabase-js بخطأ لا علاقة له بالسياسات.
-- ============================================================

-- تشديد (مراجعة PR-38-review-2): authenticated كان يملك insert/update/delete
-- مباشرة على الجدولين رغم أن كل الكتابة الموثوقة تمر أصلاً عبر RPC بـSECURITY
-- DEFINER (تعمل بصلاحيات مالكها بغض النظر عن GRANT الممنوح للمستدعي). هذا
-- كان يسمح لأي عميل authenticated بتجاوز inventory_recon_create_session_with_lines
-- كلياً عبر INSERT/UPDATE مباشر على inventory_recon_lines وتلقين system_qty/
-- unit_cost/currency مفبركة بنفسه، أو تجاوز inventory_recon_set_status لتغيير
-- status/reviewed_by/approved_by مباشرة. RLS تُقيّد الصفوف (المُلكية/الحالة)
-- لا الأعمدة، فبقيت هذه الثغرة رغم صحة السياسات. الآن: SELECT فقط، وكل كتابة
-- تمر حصراً عبر RPC (inventory_recon_create_session_with_lines وinventory_recon_set_status
-- أدناه)، اللتين لا تحتاجان GRANT على الجدول لأنهما SECURITY DEFINER.
-- نبدأ من لا صلاحيات على الجداول الثلاثة لكلا دورَي Data API، ثم نعيد منح
-- القراءة فقط للمستخدم المسجّل. هذا يمنع default privileges قديمة في المشروع
-- من منح anon أو authenticated كتابة مباشرة تتجاوز واجهات RPC الموثوقة.
revoke all privileges on table
  inventory_recon_sessions,
  inventory_recon_lines,
  inventory_recon_audit_log
from anon, authenticated;
grant select on inventory_recon_sessions to authenticated;
grant select on inventory_recon_lines to authenticated;
grant select on inventory_recon_audit_log to authenticated;

-- ============================================================
-- قراءة سطور جلسة بعرض مقنَّع: inventory_recon_lines_select أعلاه أصبحت
-- owner-only، فمنشئ الجلسة نفسه (غير المالك) لم يعد يقدر يقرأ سطور جلسته
-- عبر .from() مباشرة. هذه الدالة SECURITY DEFINER تتجاوز RLS لتُرجع سطور أي
-- جلسة يملك المستخدم الحالي صلاحية الوصول لها فعلياً (منشئها أو المالك)،
-- لكنها تُخفي unit_cost/currency/settlement_value (تُرجعها NULL) لغير
-- المالك — نفس البيانات الحسّاسة الممنوعة أصلاً على item_costs.
-- تشديد SECURITY DEFINER (مراجعة PR-38-review-1def403): search_path فارغ
-- بدل "public" وكل الأسماء مؤهَّلة صراحة بالمخطط (public./auth.) لمنع أي
-- اعتراض عبر search_path hijacking، مع رفض صريح لجلسة بلا auth.uid() بدل
-- الاعتماد الضمني على anon المرفوض أصلاً بـrevoke execute أدناه.
-- ============================================================

create or replace function inventory_recon_lines_for_session(p_session_id uuid)
returns table (
  id uuid,
  session_id uuid,
  item_key text,
  item_number text,
  item_name text,
  unit_name text,
  system_qty numeric,
  actual_qty numeric,
  diff_qty numeric,
  unit_cost numeric,
  currency text,
  settlement_value numeric,
  reason text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_owner boolean;
begin
  if auth.uid() is null then
    raise exception 'inventory_recon: يجب تسجيل الدخول للوصول إلى سطور الجلسة';
  end if;

  if not exists (
    select 1 from public.inventory_recon_sessions s
    where s.id = p_session_id
      and (s.created_by = auth.uid() or public.inventory_recon_is_owner())
  ) then
    raise exception 'inventory_recon: الجلسة % غير موجودة أو لا تملك صلاحية الوصول إليها', p_session_id;
  end if;

  v_is_owner := public.inventory_recon_is_owner();

  return query
  select
    l.id, l.session_id, l.item_key, l.item_number, l.item_name, l.unit_name,
    l.system_qty, l.actual_qty, l.diff_qty,
    case when v_is_owner then l.unit_cost else null end,
    case when v_is_owner then l.currency else null end,
    case when v_is_owner then l.settlement_value else null end,
    l.reason, l.created_at, l.updated_at
  from public.inventory_recon_lines l
  where l.session_id = p_session_id
  order by l.item_name;
end;
$$;

revoke execute on function inventory_recon_lines_for_session(uuid) from public;
revoke execute on function inventory_recon_lines_for_session(uuid) from anon;
grant execute on function inventory_recon_lines_for_session(uuid) to authenticated;

-- ============================================================
-- إنشاء الجلسة وسطورها في معاملة واحدة ذرية: بدون هذه الدالة، createReconSession
-- ثم saveReconLines طلبان منفصلان من العميل — فشل الثاني (انقطاع شبكة، إلخ)
-- يترك جلسة فارغة محفوظة بلا سطور تظهر في السجل.
--
-- ثقة البيانات: النسخة السابقة كانت تقبل system_qty وunit_cost وهوية الصنف
-- (item_number/item_name/unit_name) كما يرسلها المتصفح حرفياً — أي مستخدم
-- authenticated كان يستطيع نظرياً تمرير كمية نظام أو تكلفة مفبركة عبر RPC
-- مباشرة (تجاوز الواجهة). الآن: p_source_report_id يُحدَّد بمعرف تقرير
-- inventory_reports (source='ameen_warehouse_stock') الذي حمّلته الواجهة أصلاً،
-- والدالة تتحقق من صحته ومطابقة مستودعه محلياً هنا، ثم تشتق system_qty
-- وitem_number/item_name/unit_name من items الخاصة بالتقرير نفسه — لا من
-- p_lines. العميل يرسل فقط item_key (لتحديد أي صنف) وactual_qty وreason.
-- unit_cost يُشتق من item_costs (مطابقة GUID/كود/اسم على ما ورد بالتقرير
-- الموثوق، لا مما يرسله العميل) ويبقى NULL إن لم توجد تكلفة مسجّلة — لا بديل
-- عن تكلفة يرسلها المتصفح.
--
-- SECURITY DEFINER (وليس invoker): item_costs محمي بسياسة is_owner() (راجع
-- commit bfb4717 على الفرع الرئيسي) وinventory_recon_lines_select owner-only
-- أعلاه — فموظف غير مالك يستدعي الدالة بصلاحياته الخاصة (invoker) لن يقدر أصلاً
-- على قراءة item_costs عند الإدخال، فتُخزَّن كل التكاليف NULL نهائياً لا مؤقتاً
-- (فقدان بيانات حقيقي يمنع المالك من مراجعتها لاحقاً)، ولا على قراءة سطور جلسة
-- سابقة بنفس idempotency_key عند إعادة الإرسال فتفشل كل محاولة تكرار من موظف
-- برسالة "محتوى مختلف" رغم تطابق الطلب فعلياً. الدالة تتحقق من هوية المستخدم
-- بنفسها (auth.uid() لكل عمليات الإدخال/التصفية، ومطابقة المستودع والتقرير
-- الموثوق قبل أي كتابة) فلا حاجة لصلاحيات RLS الحية للمنفّذ.
--
-- تشديد إضافي (مراجعة PR-38-review-1def403): search_path فارغ بدل "public"
-- وكل أسماء الجداول مؤهَّلة صراحة (public.) بدل الاعتماد على search_path
-- لمنع اعتراض عبر schema يسبق public لو أُنشئ لاحقاً، مع رفض صريح لاستدعاء
-- بلا auth.uid() بدل الاعتماد الضمني فقط على revoke execute from anon أدناه.
-- ============================================================

create or replace function inventory_recon_create_session_with_lines(
  p_session_date date,
  p_session_month date,
  p_warehouse_key text,
  p_warehouse_name text,
  p_notes text,
  p_idempotency_key text,
  p_source_report_id uuid,
  p_lines jsonb
)
returns public.inventory_recon_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.inventory_recon_sessions;
  v_existing public.inventory_recon_sessions;
  v_report_summary jsonb;
  v_report_items jsonb;
  v_report_date timestamptz;
  v_report_created_by uuid;
  v_report_created_at timestamptz;
  v_report_generated_at timestamptz;
  v_report_freshness_at timestamptz;
  v_missing_keys text;
  v_new_digest text;
  v_existing_digest text;
  v_empty_key_count int;
  v_requested_distinct_count int;
  v_inserted_count int;
begin
  if auth.uid() is null then
    raise exception 'inventory_recon: يجب تسجيل الدخول لإنشاء جلسة جرد';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'inventory_recon: لا يمكن إنشاء جلسة جرد بلا سطور';
  end if;

  -- item_key فارغ/مسافات فقط كان سيسقط بصمت من الـjoin مع v_report_items
  -- لاحقاً (لن يطابق أي itemKey فعلي) فيقل عدد السطور المُدرجة بلا أي خطأ
  -- ظاهر للعميل — نرفض الطلب صراحة قبل حساب البصمة بدل ذلك.
  select count(*) into v_empty_key_count
  from jsonb_array_elements(p_lines) as line
  where trim(coalesce(line ->> 'item_key', '')) = '';
  if v_empty_key_count > 0 then
    raise exception 'inventory_recon: % سطر بمفتاح صنف فارغ — لا يمكن إرسال جلسة تحوي item_key فارغاً', v_empty_key_count;
  end if;

  if p_source_report_id is null then
    raise exception 'inventory_recon: يجب اختيار تقرير مخزون مستودع موثوق قبل إنشاء الجلسة';
  end if;

  -- مراجعة Codex على PR #40 (الجولة الثانية): source='ameen_warehouse_stock'
  -- وحده لم يكن كافياً على مستوى INSERT بجدول inventory_reports المشترك —
  -- التقرير أصبح يُقرأ الآن من ameen_warehouse_stock_reports المستقل
  -- (supabase/ameen-warehouse-stock-reports.sql)، الذي تحصر سياسة INSERT
  -- الخاصة به الكتابة بحساب المزامنة الموثوق فقط، فـcreated_by هنا موثوق
  -- بنيوياً بمجرد وجود الصف — لا اعتماد على source كقيمة وحيدة للثقة.
  select report_date::timestamptz, summary, items, created_by, created_at
    into v_report_date, v_report_summary, v_report_items, v_report_created_by, v_report_created_at
  from public.ameen_warehouse_stock_reports
  where id = p_source_report_id;

  if not found then
    raise exception 'inventory_recon: تقرير مخزون المستودع (%) غير موجود', p_source_report_id;
  end if;

  -- دفاع مضاعف: حتى لو أُنشئ الصف فعلاً بجدول ameen_warehouse_stock_reports،
  -- نتحقق مجدداً أن created_by يطابق حساب المزامنة الموثوق عبر auth.users —
  -- يحمي من أي خطأ مستقبلي بسياسة INSERT الخاصة بذلك الجدول بلا اعتماد
  -- كامل على RLS طبقة واحدة فقط.
  if not public.inventory_recon_warehouse_stock_report_is_trusted(v_report_created_by) then
    raise exception 'inventory_recon: تقرير مخزون المستودع (%) ليس من حساب المزامنة الموثوق', p_source_report_id;
  end if;

  -- مراجعة Codex على PR #40: فحص حداثة التقرير يجب أن يُطبَّق داخل RPC على
  -- الخادم أيضاً (فحص الواجهة إضافي فقط ويمكن تجاوزه من طلب مباشر).
  -- نعتمد summary.generated_at إن وُجد (وقت السحب الفعلي من الأمين)، وإلا
  -- created_at كبديل، ونرفض أي تقرير أقدم من 24 ساعة.
  v_report_generated_at := nullif(v_report_summary ->> 'generated_at', '')::timestamptz;
  v_report_freshness_at := coalesce(v_report_generated_at, v_report_created_at);
  if v_report_freshness_at is null or v_report_freshness_at < now() - interval '24 hours' then
    raise exception 'inventory_recon: تقرير مخزون المستودع (%) أقدم من 24 ساعة — اسحب تقريراً جديداً قبل إنشاء الجلسة', p_source_report_id;
  end if;

  if coalesce(v_report_summary ->> 'warehouseKey', '') <> p_warehouse_key then
    raise exception 'inventory_recon: تقرير المخزون المحدد لا يطابق المستودع المختار (%)', p_warehouse_key;
  end if;

  if v_report_items is null or jsonb_typeof(v_report_items) <> 'array' then
    raise exception 'inventory_recon: تقرير مخزون المستودع لا يحوي بيانات أصناف صالحة';
  end if;

  -- محتوى الطلب (item_key + actual_qty + reason فقط — هذا ما يملكه العميل
  -- فعلياً) يُستخدم لبناء بصمة idempotency ولمقارنة أي تكرار لاحقاً بنفس المفتاح.
  select md5(string_agg(
           coalesce(line ->> 'item_key', '') || '|' ||
           coalesce(trim_scale(nullif(line ->> 'actual_qty', '')::numeric)::text, '') || '|' ||
           coalesce(line ->> 'reason', ''),
           E'\n' order by line ->> 'item_key'
         ))
    into v_new_digest
  from jsonb_array_elements(p_lines) as line;

  -- تحقق أن كل item_key أرسله العميل موجود فعلاً في التقرير الموثوق —
  -- وإلا يُرفض الطلب بالكامل بدل تجاهل السطر المجهول بصمت.
  select string_agg(k, ', ')
    into v_missing_keys
  from (
    select distinct line ->> 'item_key' as k
    from jsonb_array_elements(p_lines) as line
    where not exists (
      select 1
      from jsonb_array_elements(v_report_items) as it
      where coalesce(it ->> 'itemKey', it ->> 'item_key') = (line ->> 'item_key')
    )
  ) missing;

  if v_missing_keys is not null then
    raise exception 'inventory_recon: الأصناف التالية غير موجودة في تقرير المستودع الموثوق: %', v_missing_keys;
  end if;

  -- idempotency: التفرد على (created_by, idempotency_key) — لا يمكن أبداً
  -- أن نرجع جلسة مستخدم آخر. النسخة السابقة كانت SELECT ثم INSERT منفصلين —
  -- بينهما نافذة سباق: طلبان متزامنان بنفس المفتاح كلاهما يجد "not found" ثم
  -- يحاول الإدخال، فيفشل أحدهما بخطأ تعارض قيد فريد خام بدل رسالة idempotency
  -- واضحة. INSERT ... ON CONFLICT DO NOTHING RETURNING * ذرّي على مستوى
  -- القاعدة: يضمن أن إدخالاً واحداً فقط ينجح مهما تزامنت الطلبات.
  insert into public.inventory_recon_sessions
    (session_date, session_month, warehouse_key, warehouse_name, notes, idempotency_key,
     source_report_id, source_report_date, status, created_by)
  values
    (p_session_date, p_session_month, p_warehouse_key, p_warehouse_name, p_notes, p_idempotency_key,
     p_source_report_id, v_report_date, 'draft', auth.uid())
  on conflict (created_by, idempotency_key) do nothing
  returning * into v_session;

  if not found then
    -- تعارض: مفتاح idempotency مستخدم مسبقاً (بهذا الطلب أو بطلب متزامن سبقنا
    -- بمايكروثانية). نتحقق أن المستودع/الشهر/التقرير المصدر/محتوى السطور
    -- مطابقة تماماً؛ خلاف ذلك نرفض بخطأ واضح بدل نجاح وهمي يعيد جلسة قديمة
    -- لا تطابق الطلب الجديد.
    select * into v_existing
    from public.inventory_recon_sessions
    where created_by = auth.uid()
      and idempotency_key = p_idempotency_key;

    if v_existing.warehouse_key is distinct from p_warehouse_key
       or v_existing.session_month is distinct from p_session_month
       or v_existing.source_report_id is distinct from p_source_report_id
    then
      raise exception 'inventory_recon: مفتاح idempotency % مستخدم مسبقاً لجلسة مختلفة (مستودع/شهر/تقرير مصدر مختلف) — أعد تحميل الصفحة وحاول من جديد', p_idempotency_key;
    end if;

    select md5(string_agg(
             coalesce(item_key, '') || '|' ||
             coalesce(trim_scale(actual_qty)::text, '') || '|' ||
             coalesce(reason, ''),
             E'\n' order by item_key
           ))
      into v_existing_digest
    from public.inventory_recon_lines
    where session_id = v_existing.id;

    if v_existing_digest is distinct from v_new_digest then
      raise exception 'inventory_recon: مفتاح idempotency % مستخدم مسبقاً بمحتوى سطور مختلف — أعد تحميل الصفحة وحاول من جديد', p_idempotency_key;
    end if;

    return v_existing;
  end if;

  -- مطابقة تكلفة item_costs تتبع نفس أولوية المفتاح المستعملة عند كتابته في
  -- tools/push-item-costs.ps1، لكن بعد فصل العمودين في ترحيل
  -- 20260827110325_fix_item_costs_true_guid.sql صار لكل عمود دلالة مختلفة:
  --   * item_costs.item_guid  = GUID الأمين الحقيقي فقط، أو NULL.
  --   * item_costs.match_key  = مفتاح منع التكرار (GUID أو كود أو اسم)، non-null دائماً.
  --
  -- ⚠️ إصلاح ملاحظة Codex P1 على PR #126: قبل هذا الإصلاح بقي الرجوعان بالكود
  -- وبالاسم يستعلمان العمود item_guid، وهو عمود لا يحوي كوداً ولا اسماً إطلاقاً
  -- بعد الترحيل — فكان كل صنف تعذّر على push-item-costs.ps1 إيجاد GUID أمين
  -- حقيقي له (item_guid = NULL) يسقط من كل مسارات المطابقة بصمت، فيأخذ
  -- unit_cost وcurrency فارغَين وتفسد قيمة التسوية دون أي خطأ ظاهر.
  --
  -- الترتيب الصحيح بعد الفصل:
  --   1) item_guid = GUID الصنف            (المسار المباشر الدقيق)
  --   2) match_key = GUID الصنف            (صفوف كُتبت قبل تشغيل push التالي،
  --      فالـGUID فيها ما يزال في match_key وitem_guid لم يُملأ بعد)
  --   3) match_key = رقم/كود الصنف         (رجوع بالكود)
  --   4) match_key = اسم الصنف             (رجوع بالاسم، غير حسّاس لحالة الأحرف)
  insert into public.inventory_recon_lines
    (session_id, item_key, item_number, item_name, unit_name, system_qty, actual_qty, unit_cost, currency, reason)
  select
    v_session.id,
    it ->> 'itemKey' as item_key,
    coalesce(it ->> 'itemNumber', it ->> 'item_number') as item_number,
    coalesce(it ->> 'itemName', it ->> 'item_name') as item_name,
    coalesce(it ->> 'unitName', it ->> 'unit_name') as unit_name,
    coalesce((coalesce(it ->> 'qty', it ->> 'stockQty', it ->> 'stock_qty'))::numeric, 0) as system_qty,
    nullif(line ->> 'actual_qty', '')::numeric as actual_qty,
    ic.avg_cost as unit_cost,
    -- item_costs.currency تُخزَّن حرفياً "$" من push-item-costs.ps1 (لا "USD")
    -- — بدون هذا التطبيع كانت كل الأسعار المشتقة ترفض قيد التحقق على العملة.
    case
      when ic.currency in ('$', 'USD', 'usd') then 'USD'
      when ic.currency in ('SYP', 'syp', 'ل.س') then 'SYP'
      else null
    end as currency,
    line ->> 'reason' as reason
  from jsonb_array_elements(p_lines) as line
  join jsonb_array_elements(v_report_items) as it
    on coalesce(it ->> 'itemKey', it ->> 'item_key') = (line ->> 'item_key')
  left join lateral (
    select ic1.avg_cost, ic1.currency
    from public.item_costs ic1
    where ic1.item_guid = nullif(trim(coalesce(it ->> 'itemGuid', it ->> 'item_guid', '')), '')
    limit 1
  ) ic_by_guid on true
  left join lateral (
    select ic2.avg_cost, ic2.currency
    from public.item_costs ic2
    where ic_by_guid.avg_cost is null
      and ic2.match_key = nullif(trim(coalesce(it ->> 'itemGuid', it ->> 'item_guid', '')), '')
    limit 1
  ) ic_by_legacy_guid on true
  left join lateral (
    select ic3.avg_cost, ic3.currency
    from public.item_costs ic3
    where ic_by_guid.avg_cost is null
      and ic_by_legacy_guid.avg_cost is null
      and ic3.match_key = nullif(trim(coalesce(it ->> 'itemNumber', it ->> 'item_number', '')), '')
    limit 1
  ) ic_by_number on true
  left join lateral (
    select ic4.avg_cost, ic4.currency
    from public.item_costs ic4
    where ic_by_guid.avg_cost is null
      and ic_by_legacy_guid.avg_cost is null
      and ic_by_number.avg_cost is null
      and lower(trim(ic4.match_key)) = lower(nullif(trim(coalesce(it ->> 'itemName', it ->> 'item_name', '')), ''))
    limit 1
  ) ic_by_name on true
  left join lateral (
    select coalesce(ic_by_guid.avg_cost, ic_by_legacy_guid.avg_cost, ic_by_number.avg_cost, ic_by_name.avg_cost) as avg_cost,
           coalesce(ic_by_guid.currency, ic_by_legacy_guid.currency, ic_by_number.currency, ic_by_name.currency) as currency
  ) ic on true;

  -- تحقق ذرّي أن كل مفتاح صنف فريد طلبه العميل فعلاً أُدرج كسطر — الـjoin
  -- أعلاه يُسقط بصمت أي item_key كان قد اجتاز فحص v_missing_keys لكن لسبب
  -- آخر (تكرار v_report_items لنفس itemKey، تعارض unique(session_id,item_key)
  -- من صف كُتب بالتزامن، إلخ) لم يُدرج فعلاً؛ بدون هذا الفحص تنجح الدالة
  -- وترجع جلسة أنقص من الطلب الأصلي بصمت.
  select count(distinct line ->> 'item_key') into v_requested_distinct_count
  from jsonb_array_elements(p_lines) as line;

  select count(*) into v_inserted_count
  from public.inventory_recon_lines
  where session_id = v_session.id;

  if v_inserted_count <> v_requested_distinct_count then
    raise exception 'inventory_recon: عدد السطور المُدرجة (%) لا يطابق عدد الأصناف المطلوبة (%) — تراجع كامل عن إنشاء الجلسة', v_inserted_count, v_requested_distinct_count;
  end if;

  return v_session;
end;
$$;

-- دفاع مستوى ثانٍ صريح قبل GRANT الضيق: CREATE FUNCTION يمنح EXECUTE لـPUBLIC
-- تلقائياً في PostgreSQL ما لم تُسحب صراحة — نفس النمط المطبَّق أعلاه على
-- inventory_recon_write_audit_log().
revoke execute on function inventory_recon_create_session_with_lines(date, date, text, text, text, text, uuid, jsonb) from public;
revoke execute on function inventory_recon_create_session_with_lines(date, date, text, text, text, text, uuid, jsonb) from anon;
grant execute on function inventory_recon_create_session_with_lines(date, date, text, text, text, text, uuid, jsonb) to authenticated;

-- ============================================================
-- inventory_recon_set_status: المسار الوحيد المسموح لتغيير حالة الجلسة
-- (draft→reviewed→approved) بعد إغلاق GRANT المباشر أعلاه. الدالة تقفل صف
-- الجلسة (SELECT ... FOR UPDATE) وتتحقق بنفسها من الملكية/الحالة الحالية
-- قبل أي تحديث — لا تعتمد فقط على inventory_recon_guard_immutable()
-- (BEFORE UPDATE trigger أعلاه) رغم أنه يكرر نفس التحقق كدفاع مستقل ثانٍ،
-- لأن الدالة SECURITY DEFINER وتتجاوز RLS بالكامل بصرف النظر عن الاستدعاء.
-- ============================================================

create or replace function inventory_recon_set_status(
  p_session_id uuid,
  p_next_status text,
  p_expected_status text
)
returns public.inventory_recon_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_is_owner boolean;
  v_session public.inventory_recon_sessions;
begin
  if v_uid is null then
    raise exception 'inventory_recon_set_status: يتطلب مستخدماً مصادقاً عليه';
  end if;

  if p_next_status not in ('reviewed', 'approved') then
    raise exception 'inventory_recon_set_status: حالة غير مسموحة %', p_next_status;
  end if;

  v_is_owner := public.inventory_recon_is_owner();

  select * into v_session
  from public.inventory_recon_sessions
  where id = p_session_id
  for update;

  if v_session.id is null then
    raise exception 'inventory_recon_set_status: الجلسة غير موجودة';
  end if;

  if v_session.status <> p_expected_status then
    raise exception 'inventory_recon_set_status: حالة الجلسة الحالية % لا تطابق المتوقع % — أعد تحميل الصفحة', v_session.status, p_expected_status;
  end if;

  if p_next_status = 'reviewed' then
    if v_session.status <> 'draft' then
      raise exception 'inventory_recon_set_status: الانتقال إلى reviewed مسموح فقط من draft';
    end if;
    if not (v_session.created_by = v_uid or v_is_owner) then
      raise exception 'inventory_recon_set_status: مراجعة الجلسة محصورة بمنشئ المسودة أو المالك';
    end if;
  elsif p_next_status = 'approved' then
    if v_session.status <> 'reviewed' then
      raise exception 'inventory_recon_set_status: الانتقال إلى approved مسموح فقط من reviewed';
    end if;
    if not v_is_owner then
      raise exception 'inventory_recon_set_status: اعتماد الجلسة محصور بحساب المالك';
    end if;
  end if;

  update public.inventory_recon_sessions
  set status = p_next_status,
      updated_at = now()
  where id = p_session_id
  returning * into v_session;

  return v_session;
end;
$$;

revoke execute on function inventory_recon_set_status(uuid, text, text) from public;
revoke execute on function inventory_recon_set_status(uuid, text, text) from anon;
grant execute on function inventory_recon_set_status(uuid, text, text) to authenticated;

-- ============================================================
-- inventory_recon_delete_draft: المسار الوحيد المسموح لحذف جلسة —
-- مسودة (draft) فقط، لمنشئها أو المالك. حذف الجلسة يُسقط سطورها تلقائياً
-- (on delete cascade في inventory_recon_lines)، وtrg_inventory_recon_audit_*
-- (AFTER DELETE، مُعرَّف أعلاه) يكتب سجل تدقيق للجلسة ولكل سطر محذوف تلقائياً
-- قبل أن يُطبَّق هذا الحذف — سجل التدقيق بلا FK فيبقى بعد اختفاء الصفوف
-- الأصلية (انظر تعليق إنشاء inventory_recon_audit_log أعلاه). reviewed/
-- approved لا تُحذف أبداً — trg_inventory_recon_guard_session (BEFORE DELETE)
-- يرفض حذف أي جلسة status='approved' كدفاع مستقل، وهذه الدالة ترفض أي حالة
-- غير draft قبل حتى محاولة الحذف.
-- ============================================================

create or replace function inventory_recon_delete_draft(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_session public.inventory_recon_sessions;
begin
  if v_uid is null then
    raise exception 'inventory_recon_delete_draft: يتطلب مستخدماً مصادقاً عليه';
  end if;

  select * into v_session
  from public.inventory_recon_sessions
  where id = p_session_id
  for update;

  if v_session.id is null then
    raise exception 'inventory_recon_delete_draft: الجلسة غير موجودة';
  end if;

  if v_session.status <> 'draft' then
    raise exception 'inventory_recon_delete_draft: لا يمكن حذف جلسة بحالة % — الحذف مسموح فقط للمسودات', v_session.status;
  end if;

  if not (v_session.created_by = v_uid or public.inventory_recon_is_owner()) then
    raise exception 'inventory_recon_delete_draft: حذف المسودة محصور بمنشئها أو المالك';
  end if;

  delete from public.inventory_recon_sessions where id = p_session_id;
end;
$$;

revoke execute on function inventory_recon_delete_draft(uuid) from public;
revoke execute on function inventory_recon_delete_draft(uuid) from anon;
grant execute on function inventory_recon_delete_draft(uuid) to authenticated;
