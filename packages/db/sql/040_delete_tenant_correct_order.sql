-- 040_delete_tenant_correct_order (применена 20260901112556)

-- 040: правильный порядок удаления.
--
-- Первая попытка упёрлась в services.techcard_version_id: услуги держат
-- версии техкарт, а я удалял версии раньше услуг. Порядок здесь не вопрос
-- вкуса — его диктуют внешние ключи, и проверять его нужно запуском,
-- а не чтением схемы.
--
-- Цепочка: движения → услуги приёма → приёмы → записи → УСЛУГИ →
-- техкарты → блоки → партии → материалы → единицы → ресурсы → кабинет.
create or replace function public.delete_tenant(p_tenant_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare nm text; tbl text;
begin
  select name into nm from tenants where id = p_tenant_id;
  if nm is null then raise exception 'кабинет не найден' using errcode='P0002'; end if;

  -- Всё, что ссылается на приёмы и записи.
  foreach tbl in array array[
    'visit_costs','stock_movements','visit_services','visits',
    'appointment_resources','appointments'
  ]
  loop execute format('delete from %I where tenant_id = $1', tbl) using p_tenant_id; end loop;

  -- Услуги держат версии техкарт — уходят раньше них.
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

  -- Блоки держат материалы.
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

  -- Люди остаются: аккаунт человека не принадлежит кабинету. Гасим только
  -- указатель на активный кабинет, иначе врач вернулся бы в несуществующий.
  update app_users set active_tenant_id = null, active_mode = 'patient', mode_chosen_at = null
   where active_tenant_id = p_tenant_id;

  delete from tenants where id = p_tenant_id;
  return jsonb_build_object('deleted', nm);
end $$;;
