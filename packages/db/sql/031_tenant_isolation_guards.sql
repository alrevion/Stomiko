-- 031_tenant_isolation_guards (применена 20260901105143)

-- 031: изоляция кабинетов на уровне базы.
--
-- Проверено до правки: из кабинета А читались данные кабинета Б —
--   visit_detail(<чужой visit_id>) → «Секретный Пациент», «+998900000001».
--
-- Причина: 13 функций, достижимых из HTTP, принимали голый UUID и владельца
-- строки не проверяли. RLS не помогала: воркер ходит под service_role, который
-- RLS обходит, а политики у нас — сплошной запрет для anon/authenticated.
--
-- Приём: не переписывать стострочные тела, а поставить перед каждой такой
-- функцией СТРАЖА с тем же именем, но с p_tenant_id первым аргументом, и
-- ОТОЗВАТЬ права на беззащитную версию у всех ролей, которыми ходит API.
-- Страж — SECURITY DEFINER во владении postgres, поэтому внутрь он попадает,
-- а снаружи туда больше не попасть.

-- ── Приём ────────────────────────────────────────────────────────────────
create or replace function public.visit_detail(p_tenant_id uuid, p_visit_id uuid)
returns jsonb language plpgsql stable security definer
set search_path to 'public','extensions' as $$
begin
  if not exists (select 1 from visits where id = p_visit_id and tenant_id = p_tenant_id) then
    raise exception 'приём не найден' using errcode='P0002';
  end if;
  return visit_detail(p_visit_id);
end $$;

create or replace function public.get_close_context(p_tenant_id uuid, p_visit_id uuid)
returns jsonb language plpgsql stable security definer
set search_path to 'public','extensions' as $$
begin
  if not exists (select 1 from visits where id = p_visit_id and tenant_id = p_tenant_id) then
    raise exception 'приём не найден' using errcode='P0002';
  end if;
  return get_close_context(p_visit_id);
end $$;

create or replace function public.apply_visit_close(p_tenant_id uuid, p_visit_id uuid, p_allocation jsonb)
returns jsonb language plpgsql security definer
set search_path to 'public','extensions' as $$
begin
  if not exists (select 1 from visits where id = p_visit_id and tenant_id = p_tenant_id) then
    raise exception 'приём не найден' using errcode='P0002';
  end if;
  return apply_visit_close(p_visit_id, p_allocation);
end $$;

-- ── Записи ───────────────────────────────────────────────────────────────
create or replace function public.cancel_appointment(
  p_tenant_id uuid, p_appointment_id uuid, p_by text, p_reason text default null)
returns jsonb language plpgsql security definer
set search_path to 'public','extensions' as $$
begin
  if not exists (select 1 from appointments where id = p_appointment_id and tenant_id = p_tenant_id) then
    raise exception 'запись не найдена' using errcode='P0002';
  end if;
  return cancel_appointment(p_appointment_id, p_by, p_reason);
end $$;

create or replace function public.mark_no_show(p_tenant_id uuid, p_appointment_id uuid)
returns jsonb language plpgsql security definer
set search_path to 'public','extensions' as $$
begin
  if not exists (select 1 from appointments where id = p_appointment_id and tenant_id = p_tenant_id) then
    raise exception 'запись не найдена' using errcode='P0002';
  end if;
  return mark_no_show(p_appointment_id);
end $$;

-- ── Техкарты ─────────────────────────────────────────────────────────────
create or replace function public.save_techcard_version(
  p_tenant_id uuid, p_service_id uuid, p_lines jsonb)
returns jsonb language plpgsql security definer
set search_path to 'public','extensions' as $$
begin
  if not exists (select 1 from services where id = p_service_id and tenant_id = p_tenant_id) then
    raise exception 'услуга не найдена' using errcode='P0002';
  end if;
  return save_techcard_version(p_service_id, p_lines);
end $$;

create or replace function public.techcard_own_lines(p_tenant_id uuid, p_version_id uuid)
returns table(line_id uuid, material_id uuid, material_ru text, analog_group_id uuid,
              analog_group_name text, norm_qty numeric, unit_id uuid, unit_ru text,
              divisible boolean, scales_with_quantity boolean, reference_price numeric)
language plpgsql stable security definer
set search_path to 'public','extensions' as $$
begin
  if not exists (
    select 1 from techcard_versions tv join techcards tc on tc.id = tv.techcard_id
     where tv.id = p_version_id and tc.tenant_id = p_tenant_id) then
    raise exception 'техкарта не найдена' using errcode='P0002';
  end if;
  return query select * from techcard_own_lines(p_version_id);
end $$;

create or replace function public.techcard_block_summary(p_tenant_id uuid, p_version_id uuid)
returns table(block_code text, block_ru text, lines bigint, version integer)
language plpgsql stable security definer
set search_path to 'public','extensions' as $$
begin
  if not exists (
    select 1 from techcard_versions tv join techcards tc on tc.id = tv.techcard_id
     where tv.id = p_version_id and tc.tenant_id = p_tenant_id) then
    raise exception 'техкарта не найдена' using errcode='P0002';
  end if;
  return query select * from techcard_block_summary(p_version_id);
end $$;

-- ── Склад ────────────────────────────────────────────────────────────────
create or replace function public.update_material(
  p_tenant_id uuid, p_material_id uuid, p_name_ru text, p_name_uz text,
  p_category text, p_reference_price numeric)
returns void language plpgsql security definer
set search_path to 'public','extensions' as $$
begin
  if not exists (select 1 from materials where id = p_material_id and tenant_id = p_tenant_id) then
    raise exception 'материал не найден' using errcode='P0002';
  end if;
  perform update_material(p_material_id, p_name_ru, p_name_uz, p_category, p_reference_price);
end $$;

create or replace function public.delete_material(p_tenant_id uuid, p_material_id uuid)
returns void language plpgsql security definer
set search_path to 'public','extensions' as $$
begin
  if not exists (select 1 from materials where id = p_material_id and tenant_id = p_tenant_id) then
    raise exception 'материал не найден' using errcode='P0002';
  end if;
  perform delete_material(p_material_id);
end $$;

create or replace function public.adjust_stock(
  p_tenant_id uuid, p_batch_id uuid, p_new_qty numeric, p_reason text)
returns void language plpgsql security definer
set search_path to 'public','extensions' as $$
begin
  if not exists (select 1 from batches where id = p_batch_id and tenant_id = p_tenant_id) then
    raise exception 'партия не найдена' using errcode='P0002';
  end if;
  perform adjust_stock(p_batch_id, p_new_qty, p_reason);
end $$;

create or replace function public.write_off_batch(p_tenant_id uuid, p_batch_id uuid, p_reason text)
returns void language plpgsql security definer
set search_path to 'public','extensions' as $$
begin
  if not exists (select 1 from batches where id = p_batch_id and tenant_id = p_tenant_id) then
    raise exception 'партия не найдена' using errcode='P0002';
  end if;
  perform write_off_batch(p_batch_id, p_reason);
end $$;

create or replace function public.acknowledge_shortfall(p_tenant_id uuid, p_movement_id uuid)
returns void language plpgsql security definer
set search_path to 'public','extensions' as $$
begin
  if not exists (select 1 from stock_movements where id = p_movement_id and tenant_id = p_tenant_id) then
    raise exception 'недостача не найдена' using errcode='P0002';
  end if;
  perform acknowledge_shortfall(p_movement_id);
end $$;

-- ── Чужой идентификатор в СВОЮ строку ────────────────────────────────────
-- Эти две уже принимали тенант, но не проверяли, что материал и единица
-- принадлежат ему же: можно было завести партию своего кабинета на чужой
-- материал. Не утечка чтения, но порча ссылочной целостности между кабинетами.
create or replace function public.receive_batch(
  p_tenant_id uuid, p_location_id uuid, p_material_id uuid, p_qty numeric,
  p_total_price numeric, p_expires_at date, p_supplier text default null,
  p_price_estimated boolean default false)
returns uuid language plpgsql security definer
set search_path to 'public','extensions' as $$
declare bid uuid;
begin
  if p_qty <= 0 then raise exception 'приход должен быть положительным' using errcode='P0001'; end if;
  if not exists (select 1 from materials where id = p_material_id and tenant_id = p_tenant_id) then
    raise exception 'материал не найден' using errcode='P0002';
  end if;
  if not exists (select 1 from locations where id = p_location_id and tenant_id = p_tenant_id) then
    raise exception 'филиал не найден' using errcode='P0002';
  end if;

  insert into batches (tenant_id, location_id, material_id, initial_qty, qty_remaining,
                       total_price, price_estimated, expires_at, supplier)
    values (p_tenant_id, p_location_id, p_material_id, p_qty, p_qty,
            p_total_price, p_price_estimated, p_expires_at, p_supplier)
    returning id into bid;

  insert into stock_movements (tenant_id, location_id, kind, batch_id, material_id,
                               qty_delta, cost, unpriced)
    values (p_tenant_id, p_location_id, 'receipt', bid, p_material_id,
            p_qty, p_total_price, p_total_price is null);
  return bid;
end $$;

create or replace function public.create_material(
  p_tenant_id uuid, p_name_ru text, p_name_uz text, p_unit_id uuid,
  p_category text, p_reference_price numeric)
returns uuid language plpgsql security definer
set search_path to 'public','extensions' as $$
declare mid uuid;
begin
  if coalesce(trim(p_name_ru),'') = '' then
    raise exception 'укажите название материала' using errcode='P0001';
  end if;
  if not exists (select 1 from units where id = p_unit_id and tenant_id = p_tenant_id) then
    raise exception 'единица измерения не найдена' using errcode='P0002';
  end if;
  if exists (select 1 from materials where tenant_id = p_tenant_id and lower(name_ru) = lower(trim(p_name_ru))) then
    raise exception 'материал «%» уже есть на складе', trim(p_name_ru) using errcode='P0001';
  end if;
  insert into materials (tenant_id, name_ru, name_uz, base_unit_id, category, reference_price)
    values (p_tenant_id, trim(p_name_ru), coalesce(nullif(trim(p_name_uz),''), trim(p_name_ru)),
            p_unit_id, nullif(trim(p_category),''), p_reference_price)
    returning id into mid;
  return mid;
end $$;

-- ── Закрываем беззащитные версии ─────────────────────────────────────────
-- Снаружи их вызвать больше нельзя; стражи попадают внутрь как владельцы.
do $$
declare sig text;
begin
  foreach sig in array array[
    'visit_detail(uuid)',
    'get_close_context(uuid)',
    'apply_visit_close(uuid, jsonb)',
    'cancel_appointment(uuid, text, text)',
    'mark_no_show(uuid)',
    'save_techcard_version(uuid, jsonb)',
    'techcard_own_lines(uuid)',
    'techcard_block_summary(uuid)',
    'expand_techcard_version(uuid)',
    'update_material(uuid, text, text, text, numeric)',
    'delete_material(uuid)',
    'adjust_stock(uuid, numeric, text)',
    'write_off_batch(uuid, text)',
    'acknowledge_shortfall(uuid)'
  ]
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated, service_role', sig);
  end loop;
end $$;

-- Cron ходит под service_role и обслуживает ВСЕ кабинеты сразу — тенант этим
-- двум не передаётся осознанно. Из HTTP они недостижимы.
comment on function public.due_reminders(timestamptz) is
  'Без тенанта намеренно: cron по всем кабинетам. Из HTTP не вызывается.';
comment on function public.mark_reminded(uuid, text) is
  'Без тенанта намеренно: вызывается только cron с id из due_reminders.';
comment on function public.redeem_staff_invite(text, text) is
  'Без тенанта намеренно: тенант выводится из самого приглашения, оно и есть право.';;
