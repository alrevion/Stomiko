-- 024_warehouse_views (применена 20260825104741)

-- Склад — единственное место, где заводятся и правятся материалы.
-- Техкарта только выбирает из уже имеющегося: нельзя нормировать расход того,
-- чего нет на складе, и нельзя завести материал «по дороге», составляя карту.

create or replace function stock_overview(p_tenant_id uuid)
returns table (
  material_id uuid, name_ru text, name_uz text, category text,
  unit_ru text, unit_code text, divisible boolean,
  reference_price numeric, qty_remaining numeric,
  batches int, nearest_expiry date, expired_qty numeric,
  used_in_techcards bigint
)
language sql stable security definer set search_path = public, extensions
as $$
  select m.id, m.name_ru, m.name_uz, m.category,
         u.name_ru, u.code, u.divisible,
         m.reference_price,
         coalesce((select sum(b.qty_remaining) from batches b
                    where b.material_id = m.id and b.tenant_id = p_tenant_id), 0),
         (select count(*)::int from batches b
           where b.material_id = m.id and b.tenant_id = p_tenant_id and b.qty_remaining > 0),
         (select min(b.expires_at) from batches b
           where b.material_id = m.id and b.tenant_id = p_tenant_id and b.qty_remaining > 0),
         coalesce((select sum(b.qty_remaining) from batches b
                    where b.material_id = m.id and b.tenant_id = p_tenant_id
                      and b.qty_remaining > 0 and b.expires_at < current_date), 0),
         -- Сколько техкарт опирается на этот материал: удалять такой нельзя.
         (select count(*) from techcard_lines tl where tl.material_id = m.id)
       + (select count(*) from techcard_block_lines bl where bl.material_id = m.id)
    from materials m
    join units u on u.id = m.base_unit_id
   where m.tenant_id = p_tenant_id
   order by m.category nulls last, m.name_ru;
$$;

/** Партии одного материала — для прихода, корректировки и утилизации. */
create or replace function material_batches(p_tenant_id uuid, p_material_id uuid)
returns table (
  batch_id uuid, initial_qty numeric, qty_remaining numeric,
  total_price numeric, price_estimated boolean,
  expires_at date, supplier text, created_at timestamptz, expired boolean
)
language sql stable security definer set search_path = public, extensions
as $$
  select b.id, b.initial_qty, b.qty_remaining, b.total_price, b.price_estimated,
         b.expires_at, b.supplier, b.created_at,
         (b.expires_at is not null and b.expires_at < current_date)
    from batches b
   where b.tenant_id = p_tenant_id and b.material_id = p_material_id
   order by b.qty_remaining = 0, b.expires_at nulls last;
$$;

/**
 * Новый материал заводится ТОЛЬКО здесь. Единица берётся из справочника
 * кабинета: делимость — свойство материала (карпулу вскрыл — потратил целиком,
 * бор амортизируется), и ошибиться в ней дороже, чем в норме расхода.
 */
create or replace function create_material(
  p_tenant_id uuid, p_name_ru text, p_name_uz text,
  p_unit_id uuid, p_category text, p_reference_price numeric
) returns uuid
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare mid uuid;
begin
  if coalesce(trim(p_name_ru),'') = '' then
    raise exception 'укажите название материала' using errcode='P0001';
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

create or replace function update_material(
  p_material_id uuid, p_name_ru text, p_name_uz text,
  p_category text, p_reference_price numeric
) returns void
language plpgsql volatile security definer set search_path = public, extensions
as $$
begin
  update materials
     set name_ru = coalesce(nullif(trim(p_name_ru),''), name_ru),
         name_uz = coalesce(nullif(trim(p_name_uz),''), name_uz),
         category = nullif(trim(p_category),''),
         reference_price = p_reference_price
   where id = p_material_id;
  if not found then raise exception 'материал не найден' using errcode='P0002'; end if;
end $$;

/** Удалить материал можно, только если на него не ссылается ни одна техкарта. */
create or replace function delete_material(p_material_id uuid)
returns void
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare used bigint;
begin
  select (select count(*) from techcard_lines where material_id = p_material_id)
       + (select count(*) from techcard_block_lines where material_id = p_material_id)
    into used;
  if used > 0 then
    raise exception 'материал используется в % техкартах — сначала уберите его оттуда', used
      using errcode='P0001';
  end if;
  if exists (select 1 from stock_movements where material_id = p_material_id) then
    raise exception 'по материалу есть движения склада — его нельзя удалить, только списать остаток'
      using errcode='P0001';
  end if;
  delete from materials where id = p_material_id;
end $$;

revoke all on function stock_overview(uuid) from public, anon, authenticated;
revoke all on function material_batches(uuid,uuid) from public, anon, authenticated;
revoke all on function create_material(uuid,text,text,uuid,text,numeric) from public, anon, authenticated;
revoke all on function update_material(uuid,text,text,text,numeric) from public, anon, authenticated;
revoke all on function delete_material(uuid) from public, anon, authenticated;;
