-- 054c_guards_and_delete_tenant

-- Новые таблицы держат УСЛУГИ (позиции плана) и ПАЦИЕНТОВ (платежи) ссылками
-- на restrict: без них в цепочке удаление кабинета обрывается на середине.
/* ── Удаление кабинета: новые таблицы держат услуги и пациентов ──────── */

create or replace function public.delete_tenant(p_tenant_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare nm text; tbl text;
begin
  select name into nm from tenants where id = p_tenant_id;
  if nm is null then raise exception 'кабинет не найден' using errcode='P0002'; end if;

  -- Планы и платежи идут первыми: позиции плана держат УСЛУГИ, платежи —
  -- ПАЦИЕНТОВ, и обе ссылки на restrict.
  foreach tbl in array array[
    'treatment_plan_items','treatment_plans','payments',
    'visit_costs','stock_movements','visit_services','visits',
    'appointment_resources','appointments'
  ]
  loop execute format('delete from %I where tenant_id = $1', tbl) using p_tenant_id; end loop;

  delete from services where tenant_id = p_tenant_id;

  delete from techcard_expanded where techcard_version_id in
    (select tv.id from techcard_versions tv join techcards tc on tc.id = tv.techcard_id
      where tc.tenant_id = p_tenant_id);
  delete from techcard_lines where techcard_version_id in
    (select tv.id from techcard_versions tv join techcards tc on tc.id = tv.techcard_id
      where tc.tenant_id = p_tenant_id);
  delete from techcard_versions where techcard_id in
    (select id from techcards where tenant_id = p_tenant_id);
  delete from techcards where tenant_id = p_tenant_id;

  delete from techcard_block_lines where block_version_id in
    (select bv.id from techcard_block_versions bv join techcard_blocks b on b.id = bv.block_id
      where b.tenant_id = p_tenant_id);
  delete from techcard_block_versions where block_id in
    (select id from techcard_blocks where tenant_id = p_tenant_id);
  delete from techcard_blocks where tenant_id = p_tenant_id;

  delete from analog_group_members where group_id in
    (select id from analog_groups where tenant_id = p_tenant_id);

  foreach tbl in array array[
    'batches','patients','analog_groups','materials','units',
    'working_hours','schedule_overrides','booking_settings',
    'staff_invites','memberships','resources','locations'
  ]
  loop execute format('delete from %I where tenant_id = $1', tbl) using p_tenant_id; end loop;

  update app_users set active_tenant_id = null, active_mode = 'patient', mode_chosen_at = null
   where active_tenant_id = p_tenant_id;

  delete from tenants where id = p_tenant_id;
  return jsonb_build_object('deleted', nm);
end $$;


/* ── Сторожа знают о новых таблицах и функциях ───────────────────────── */

create or replace function public.rls_health()
returns jsonb
language plpgsql stable security definer set search_path to 'public','extensions' as $$
declare
  expected text[] := array[
    'locations','memberships','resources','patients','appointments',
    'appointment_resources','visits','units','materials','analog_groups',
    'batches','techcard_blocks','techcards','services','visit_services',
    'stock_movements','visit_costs','working_hours','schedule_overrides',
    'booking_settings','treatment_plans','treatment_plan_items','payments'];
  missing text[];
  без_политики text[];
begin
  select array_agg(t) into missing
    from unnest(expected) t
   where not exists (
     select 1 from pg_policies p
      where p.schemaname = 'public' and p.tablename = t and p.policyname = t || '_own_tenant');

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
       'confirm_appointment', 'my_treatment_plans',
       -- Цена материала и триггер закрытия работают внутри уже проверенного
       -- вызова: своего тенанта у них нет, они его и не выбирают.
       'material_unit_price', 'tg_close_plan_items',
       'set_verified_phone', 'normalize_phone',
       'provision_tenant', 'provision_tenant_core', 'available_templates',
       'template_health', 'subscription_plans_list', 'due_subscription_notices',
       'rls_health', 'prune_access_log'
     )
     and has_function_privilege('service_role', p.oid, 'execute')
   order by p.proname;
$$;

do $$
declare sig text;
begin
  foreach sig in array array[
    'material_unit_price(uuid)',
    'service_expected_cost(uuid, uuid, integer)',
    'treatment_plan(uuid, uuid)',
    'patient_plans(uuid, uuid)',
    'save_treatment_plan(uuid, uuid, uuid, text, text, text, jsonb, text)',
    'delete_treatment_plan(uuid, uuid)',
    'patient_balance(uuid, uuid)',
    'record_payment(uuid, uuid, numeric, text, text, text)',
    'patient_payments(uuid, uuid)',
    'my_treatment_plans(text)'
  ]
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', sig);
  end loop;
end $$;
