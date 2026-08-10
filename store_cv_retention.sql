-- ============================================================================
-- ProSkill — تنظيف طلبات السيرة الذاتية غير المكتملة
-- شغّله مرة واحدة في Supabase SQL Editor. آمن للتشغيل أكثر من مرة.
--
-- لماذا:
--   الطلب غير المدفوع يحمل السيرة الذاتية الكاملة للعميل وصورته وبيانات
--   تواصله — بيانات شخصية حساسة لطلب لم يكتمل أصلاً. الاحتفاظ بها إلى الأبد
--   يخالف ما وعدنا به العميل في النموذج: "تُستخدم لإنشاء سيرتك فقط".
--
--   الطلبات المدفوعة تبقى كما هي: العميل دفع، وقد يعود لتحميل سيرته لاحقاً،
--   وهي أيضاً سجلك المحاسبي.
--
-- ماذا يفعل:
--   يمسح محتوى الطلبات غير المدفوعة الأقدم من 7 أيام — النصوص والصورة فقط،
--   مع إبقاء الصف نفسه حتى لا تختفي إحصائياتك (كم طلباً بدأ ولم يُدفع).
-- ============================================================================

create or replace function purge_abandoned_cv_orders()
returns integer
language plpgsql
security definer
as $$
declare
  v_count integer;
begin
  with purged as (
    update ps_cv_orders
    set source_text    = '',            -- العمود not null، لذا نفرّغه بدل حذفه
        job_description = null,
        photo_url      = null,
        customer_phone = null,
        error_note     = coalesce(error_note, 'purged: abandoned')
    where payment_status = 'unpaid'
      and created_at < now() - interval '7 days'
      and source_text <> ''             -- لا تعِد معالجة ما نُظّف سابقاً
    returning 1
  )
  select count(*) into v_count from purged;

  return v_count;
end;
$$;

comment on function purge_abandoned_cv_orders is
  'Clears personal data from CV orders abandoned before payment. Run on a schedule.';

-- ---------------------------------------------------------------------------
-- الجدولة اليومية (تتطلب إضافة pg_cron من Database → Extensions في Supabase).
-- إن لم تكن متاحة، يمكن استدعاء الدالة يدوياً من محرر SQL كل فترة:
--     select purge_abandoned_cv_orders();
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('purge-abandoned-cv')
      where exists (select 1 from cron.job where jobname = 'purge-abandoned-cv');

    perform cron.schedule(
      'purge-abandoned-cv',
      '0 3 * * *',                      -- 3 صباحاً يومياً
      $cron$ select purge_abandoned_cv_orders(); $cron$
    );
  end if;
end $$;
