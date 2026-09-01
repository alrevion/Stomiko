-- 049_rls_health (применена 20260901120935)

-- 049: сторож за политиками.
--
-- Политика, которую случайно удалили или создали не на ту таблицу, не даёт
-- о себе знать: под service_role всё работает по-прежнему, а второй слой
-- защиты тихо исчезает. Замечается это на утечке, то есть поздно.
--
-- Здесь же живая проба: заводим временную сессию с чужим claim и смотрим,
-- что видно. Проверять наличие политики недостаточно — важно, что она
-- РАБОТАЕТ, а не просто числится.
create or replace function public.rls_health()
returns jsonb
language plpgsql stable security definer set search_path to 'public','extensions' as $$
declare
  expected text[] := array[
    'locations','memberships','resources','patients','appointments',
    'appointment_resources','visits','units','materials','analog_groups',
    'batches','techcard_blocks','techcards','services','visit_services',
    'stock_movements','visit_costs','working_hours','schedule_overrides',
    'booking_settings'];
  missing text[];
  без_политики text[];
  видно_без_claim bigint;
  видно_чужим bigint;
  own uuid;
begin
  -- Таблицы, на которых нет политики «свой кабинет».
  select array_agg(t) into missing
    from unnest(expected) t
   where not exists (
     select 1 from pg_policies p
      where p.schemaname = 'public' and p.tablename = t and p.policyname = t || '_own_tenant');

  -- Таблицы с включённым RLS, но без единой политики: доступ закрыт наглухо,
  -- что тоже поломка, просто в другую сторону.
  select array_agg(c.relname::text) into без_политики
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
     and not exists (select 1 from pg_policies p
                      where p.schemaname='public' and p.tablename = c.relname);

  return jsonb_build_object(
    'tables',            array_length(expected, 1),
    'missing_policy',    coalesce(missing, '{}'),
    'rls_without_policy', coalesce(без_политики, '{}')
  );
end $$;

/**
 * Живая проба изоляции.
 *
 * Отдельной функцией, а не внутри rls_health: она меняет роль сессии, а
 * значит не может быть stable. Возвращает то, что увидел бы клиент
 * с чужим или пустым claim — должно быть ноль в обоих случаях.
 */
create or replace function public.rls_probe()
returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare без_claim bigint; чужой bigint; свой bigint; own uuid;
begin
  select id into own from tenants limit 1;

  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  set local role authenticated;
  select count(*) into без_claim from patients;
  reset role;

  perform set_config('request.jwt.claims',
    json_build_object('role','authenticated','tenant_id', gen_random_uuid())::text, true);
  set local role authenticated;
  select count(*) into чужой from patients;
  reset role;

  perform set_config('request.jwt.claims',
    json_build_object('role','authenticated','tenant_id', own)::text, true);
  set local role authenticated;
  select count(*) into свой from patients;
  reset role;

  perform set_config('request.jwt.claims', '', true);
  return jsonb_build_object('без_claim', без_claim, 'чужой_кабинет', чужой, 'свой_кабинет', свой);
end $$;

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
       'rls_health', 'rls_probe'   -- проверяют саму защиту, данных не отдают
     )
     and has_function_privilege('service_role', p.oid, 'execute')
   order by p.proname;
$$;;
