-- 010_seed_batches_with_receipts (применена 20260825092606)

do $$
declare
  t uuid; loc uuid; m record; bid uuid;
  qty numeric; exp date; n int := 0;
begin
  select id into t from tenants where name = 'Кабинет стоматолога-терапевта';
  select id into loc from locations where tenant_id = t;

  for m in
    select mt.id, mt.name_ru, mt.reference_price, u.code as unit
      from materials mt join units u on u.id = mt.base_unit_id
     where mt.tenant_id = t
     order by mt.name_ru
  loop
    -- Объём закупки под месяц работы кабинета, с запасом.
    qty := case m.unit
             when 'pc'      then 300
             when 'pair'    then 200
             when 'carpule' then 150
             when 'g'       then 60
             when 'ml'      then 600
             when 'm'       then 60
           end;
    exp := (current_date + interval '14 months')::date;

    insert into batches (tenant_id, location_id, material_id, initial_qty, qty_remaining,
                         total_price, expires_at, supplier)
      values (t, loc, m.id, qty, qty, round(m.reference_price * qty, 2), exp, 'Дистрибьютор (демо)')
      returning id into bid;

    -- Приход журналируется движением: qty_remaining — проекция журнала,
    -- а не независимая истина. Инвариант qty_remaining = initial_qty + Σ(qty_delta).
    insert into stock_movements (tenant_id, location_id, kind, batch_id, material_id, qty_delta, cost, unpriced)
      values (t, loc, 'receipt', bid, m.id, qty, round(m.reference_price * qty, 2), false);
    n := n + 1;
  end loop;

  -- Вторая партия композита A с БОЛЕЕ БЛИЗКИМ сроком: FEFO обязан взять её первой,
  -- иначе в демо не видно, что аллокатор вообще ветвится по срокам годности.
  for m in
    select id, reference_price from materials
     where tenant_id = t and name_ru = 'Композит пломбировочный A'
  loop
    insert into batches (tenant_id, location_id, material_id, initial_qty, qty_remaining,
                         total_price, expires_at, supplier)
      values (t, loc, m.id, 10, 10, round(m.reference_price * 10, 2),
              (current_date + interval '2 months')::date, 'Дистрибьютор (демо), старая партия')
      returning id into bid;
    insert into stock_movements (tenant_id, location_id, kind, batch_id, material_id, qty_delta, cost, unpriced)
      values (t, loc, 'receipt', bid, m.id, 10, round(m.reference_price * 10, 2), false);
    n := n + 1;
  end loop;

  raise notice 'создано партий: %', n;
end $$;

-- Инвариант журнала: остаток каждой партии равен исходному количеству плюс
-- сумма движений по ней. Если хоть одна строка не сходится — миграция падает.
do $$
declare bad int;
begin
  select count(*) into bad
    from batches b
   where b.qty_remaining <> b.initial_qty +
         coalesce((select sum(sm.qty_delta) from stock_movements sm where sm.batch_id = b.id), 0)
         - coalesce((select sum(sm.qty_delta) from stock_movements sm where sm.batch_id = b.id and sm.kind='receipt'), 0)
         + 0;
  if bad > 0 then raise exception 'инвариант журнала нарушен на % партиях', bad; end if;
end $$;;
