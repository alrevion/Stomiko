-- 050_drop_rls_probe (применена 20260901121012)

-- 050: живая проба изоляции не может жить в функции.
--
-- Postgres запрещает SET ROLE внутри SECURITY DEFINER, а без смены роли
-- проба бессмысленна: service_role обходит RLS и увидит всё независимо от
-- политик. Функция, которая «проверяет» защиту, но при этом её обходит,
-- хуже отсутствия проверки — она даёт ложную уверенность.
--
-- Структурная проверка (есть ли политики и на тех ли таблицах) остаётся
-- в rls_health. Живая проба переезжает в preflight и включится, когда будет
-- настроен секрет подписи: тогда её можно сделать честно — настоящим
-- запросом под настоящим токеном, а не имитацией внутри базы.
drop function if exists public.rls_probe();

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
       'template_health', 'subscription_plans_list', 'due_subscription_notices',
       'rls_health'
     )
     and has_function_privilege('service_role', p.oid, 'execute')
   order by p.proname;
$$;;
