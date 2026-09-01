-- 014_stock_operations (применена 20260825094239)

-- Складские операции — замкнутый набор. Без них у варианта A′ нет дна:
-- после онбординга партии появиться не могли бы, и доля недостач росла бы
-- монотонно, а врач ничего не мог бы с этим сделать внутри продукта.
--
-- Каждая операция атомарна: партия и движение пишутся одной функцией, иначе
-- проекция qty_remaining разъедется с журналом на первом же сбое сети.

create or replace function receive_batch(
  p_tenant_id uuid, p_location_id uuid, p_material_id uuid,
  p_qty numeric, p_total_price numeric, p_expires_at date,
  p_supplier text default null, p_price_estimated boolean default false
) returns uuid
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare bid uuid;
begin
  if p_qty <= 0 then raise exception 'приход должен быть положительным' using errcode='P0001'; end if;

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

-- Корректировка остатка. Это НЕ «кнопка списать» из потока врача: она живёт на
-- складском экране, требует причины и не является условием закрытия приёма.
create or replace function adjust_stock(
  p_batch_id uuid, p_new_qty numeric, p_reason text
) returns void
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare b batches%rowtype; delta numeric;
begin
  if coalesce(trim(p_reason),'') = '' then
    raise exception 'корректировка без причины запрещена' using errcode='P0001';
  end if;
  select * into b from batches where id = p_batch_id for update;
  if not found then raise exception 'партия не найдена' using errcode='P0002'; end if;
  if p_new_qty < 0 then raise exception 'остаток не может быть отрицательным' using errcode='P0001'; end if;

  delta := p_new_qty - b.qty_remaining;
  if delta = 0 then return; end if;

  update batches set qty_remaining = p_new_qty where id = p_batch_id;
  insert into stock_movements (tenant_id, location_id, kind, batch_id, material_id,
                               qty_delta, cost, unpriced, reason)
    values (b.tenant_id, b.location_id, 'adjustment', b.id, b.material_id,
            delta, null, true, p_reason);
end $$;

create or replace function write_off_batch(p_batch_id uuid, p_reason text)
returns void
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare b batches%rowtype;
begin
  select * into b from batches where id = p_batch_id for update;
  if not found then raise exception 'партия не найдена' using errcode='P0002'; end if;
  if b.qty_remaining = 0 then return; end if;

  insert into stock_movements (tenant_id, location_id, kind, batch_id, material_id,
                               qty_delta, cost, unpriced, reason)
    values (b.tenant_id, b.location_id, 'write_off', b.id, b.material_id,
            -b.qty_remaining, null, true, coalesce(p_reason,'утилизация'));
  update batches set qty_remaining = 0 where id = p_batch_id;
end $$;

-- Гашение недостачи: меняет ТОЛЬКО состояние строки, себестоимость закрытого
-- приёма остаётся неизменной. Иначе Принцип 4 нарушался бы задним числом.
create or replace function acknowledge_shortfall(p_movement_id uuid)
returns void
language plpgsql volatile security definer set search_path = public, extensions
as $$
begin
  update stock_movements set shortfall_state = 'acknowledged'
   where id = p_movement_id and kind = 'shortfall' and shortfall_state = 'open';
  if not found then raise exception 'открытая недостача % не найдена', p_movement_id using errcode='P0002'; end if;
end $$;

revoke all on function receive_batch(uuid,uuid,uuid,numeric,numeric,date,text,boolean) from public, anon, authenticated;
revoke all on function adjust_stock(uuid,numeric,text) from public, anon, authenticated;
revoke all on function write_off_batch(uuid,text) from public, anon, authenticated;
revoke all on function acknowledge_shortfall(uuid) from public, anon, authenticated;;
