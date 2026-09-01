-- 039_delete_tenant (применена 20260901112524)

-- 039: удаление кабинета целиком.
--
-- Обнаружилось при уборке после проверки шаблона: удалить кабинет было нечем,
-- а порядок удаления неочевиден — материалы держатся строками блоков, блоки
-- версиями, версии техкартами. Ручная попытка упирается в ссылочную
-- целостность на третьем шаге, и остаётся полуудалённый кабинет.
--
-- Понадобится трижды: уборка после проверок, очистка обучения (шаг 6) и
-- удаление аккаунта по запросу владельца.
create or replace function public.delete_tenant(p_tenant_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare nm text; tbl text;
begin
  select name into nm from tenants where id = p_tenant_id;
  if nm is null then raise exception 'кабинет не найден' using errcode='P0002'; end if;

  -- Техкарты: снимок → строки → версии → сами карты.
  delete from techcard_expanded where techcard_version_id in
    (select tv.id from techcard_versions tv join techcards tc on tc.id = tv.techcard_id
      where tc.tenant_id = p_tenant_id);
  delete from techcard_lines where techcard_version_id in
    (select tv.id from techcard_versions tv join techcards tc on tc.id = tv.techcard_id
      where tc.tenant_id = p_tenant_id);
  delete from techcard_versions where techcard_id in
    (select id from techcards where tenant_id = p_tenant_id);
  delete from techcards where tenant_id = p_tenant_id;

  -- Блоки держат материалы, поэтому уходят раньше них.
  delete from techcard_block_lines where block_version_id in
    (select bv.id from techcard_block_versions bv join techcard_blocks b on b.id = bv.block_id
      where b.tenant_id = p_tenant_id);
  delete from techcard_block_versions where block_id in
    (select id from techcard_blocks where tenant_id = p_tenant_id);
  delete from techcard_blocks where tenant_id = p_tenant_id;

  delete from analog_group_members where group_id in
    (select id from analog_groups where tenant_id = p_tenant_id);

  -- Остальное — в порядке «дети раньше родителей».
  foreach tbl in array array[
    'visit_costs','stock_movements','visit_services','visits',
    'appointment_resources','appointments','batches','patients',
    'analog_groups','materials','units',
    'working_hours','schedule_overrides','booking_settings',
    'staff_invites','memberships','resources','locations'
  ]
  loop
    execute format('delete from %I where tenant_id = $1', tbl) using p_tenant_id;
  end loop;

  -- Люди остаются: аккаунт человека не принадлежит кабинету. Гасим только
  -- указатель на активный кабинет, иначе врач вернётся в несуществующий.
  update app_users set active_tenant_id = null, active_mode = 'patient', mode_chosen_at = null
   where active_tenant_id = p_tenant_id;

  delete from tenants where id = p_tenant_id;
  return jsonb_build_object('deleted', nm);
end $$;;
