-- 047_subscription_notices (применена 20260901114545)

-- 047: предупреждения перед заморозкой.
--
-- Владелец выбрал жёсткую заморозку. Значит вся работа переносится сюда:
-- кабинет, погасший без предупреждения, — это пациенты, приехавшие
-- к закрытой двери, и виноватыми они сочтут врача, а не нас.
--
-- Этап запоминается на подписке, иначе cron раз в пятнадцать минут слал бы
-- одно и то же, и врач отключил бы бота вместе с уведомлениями о записях.
create or replace function public.due_subscription_notices()
returns table(tenant_id uuid, cabinet text, stage text, days_left int,
              paid_until timestamptz, subjects text[])
language sql stable security definer set search_path to 'public','extensions' as $$
  with st as (
    select s.tenant_id, t.name,
           s.paid_until,
           greatest(0, ceil(extract(epoch from (s.paid_until - now())) / 86400))::int as days_left,
           s.notified_stage,
           case
             when s.paid_until < now()                      then 'frozen'
             when s.paid_until < now() + interval '1 day'   then 'last_day'
             when s.paid_until < now() + interval '3 days'  then 'd3'
             when s.paid_until < now() + interval '7 days'  then 'd7'
           end as stage
      from subscriptions s join tenants t on t.id = s.tenant_id
  )
  select st.tenant_id, st.name, st.stage, st.days_left, st.paid_until,
         array(select m.subject from memberships m where m.tenant_id = st.tenant_id)
    from st
   where st.stage is not null
     and st.notified_stage is distinct from st.stage;
$$;

create or replace function public.mark_subscription_notified(p_tenant_id uuid, p_stage text)
returns void
language sql security definer set search_path to 'public','extensions' as $$
  update subscriptions set notified_stage = p_stage, updated_at = now()
   where tenant_id = p_tenant_id;
$$;

create or replace function public.audit_tenant_guards()
returns table(имя text, аргументы text, причина text)
language sql stable security definer
set search_path to 'public','extensions','pg_catalog' as $$
  select p.proname::text, pg_get_function_arguments(p.oid),
         'достижима снаружи и не проверяет кабинет'
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef and p.prokind = 'f'
     and pg_get_function_arguments(p.oid) not like '%p_tenant_id%'
     and p.proname not in (
       'due_reminders', 'mark_reminded', 'redeem_staff_invite',
       'new_public_token', 'rotate_public_token', 'audit_tenant_guards',
       'touch_app_user', 'user_context', 'set_user_mode', 'my_appointments',
       'set_verified_phone', 'normalize_phone',
       'provision_tenant', 'provision_tenant_core', 'available_templates',
       'template_health', 'subscription_plans_list',
       'due_subscription_notices'   -- cron по всем кабинетам, как due_reminders
     )
     and has_function_privilege('service_role', p.oid, 'execute')
   order by p.proname;
$$;;
