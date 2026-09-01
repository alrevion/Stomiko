-- Stomiko 006: две функции цепочки закрытия приёма.
--
-- closeVisit устроен как ДВА round-trip'а, а не один:
--   RTT 1  get_close_context  — снимок техкарт + кандидатные партии
--   (в JS) чистый аллокатор FEFO из @stomiko/core, ни одного обращения к БД
--   RTT 2  apply_visit_close  — одна транзакция: сверка версий, движения, снимок
--
-- Почему не одним вызовом с аллокатором в plpgsql: аллокатор — то место, где живёт
-- вся арифметика себестоимости, и он обязан тестироваться без БД. Размен: лишний
-- round-trip (~20 мс из Варшавы во Франкфурт) против тестируемости ядра.

create or replace function get_close_context(p_visit_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v visits%rowtype;
begin
  select * into v from visits where id = p_visit_id;
  if not found then
    raise exception 'приём % не найден', p_visit_id using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'visit', jsonb_build_object(
      'id', v.id,
      'tenantId', v.tenant_id,
      'locationId', v.location_id,
      'visitDate', v.visit_date,
      'status', v.status
    ),
    'services', coalesce((
      select jsonb_agg(jsonb_build_object(
        'visitServiceId', vs.id,
        'serviceId', vs.service_id,
        'quantity', vs.quantity,
        'price', vs.price::text,
        'lines', coalesce((
          select jsonb_agg(jsonb_build_object(
            'lineId', te.id,
            'materialId', te.material_id,
            'analogGroupId', te.analog_group_id,
            'analogMaterialIds', to_jsonb(te.analog_material_ids),
            'normQty', te.norm_qty::text,
            'divisible', te.divisible,
            'scalesWithQuantity', te.scales_with_quantity
          ) order by te.id)
          from techcard_expanded te
          where te.techcard_version_id = vs.techcard_version_id
        ), '[]'::jsonb)
      ) order by vs.created_at)
      from visit_services vs
      where vs.visit_id = v.id
    ), '[]'::jsonb),
    -- Отдаются ВСЕ партии филиала, включая исчерпанные и просроченные: аллокатор
    -- фильтрует их сам, а исчерпанные нужны ему как источник последней известной
    -- цены для оценки недостачи.
    -- ponytail: без пагинации. Кабинет копит ~500 партий в год — приемлемо;
    -- при переходе на сеть филиалов ограничить окном по created_at.
    'batches', coalesce((
      select jsonb_agg(jsonb_build_object(
        'batchId', b.id,
        'materialId', b.material_id,
        'initialQty', b.initial_qty::text,
        'qtyRemaining', b.qty_remaining::text,
        'totalPrice', case when b.total_price is null then null else b.total_price::text end,
        'expiresAt', b.expires_at
      ) order by b.expires_at nulls last, b.id)
      from batches b
      where b.tenant_id = v.tenant_id
        and b.location_id = v.location_id
    ), '[]'::jsonb)
  );
end $$;


create or replace function apply_visit_close(p_visit_id uuid, p_allocation jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v             visits%rowtype;
  existing      visit_costs%rowtype;
  closed_rows   int;
  rec           record;
  b             batches%rowtype;
  cost_id       uuid;
begin
  select * into v from visits where id = p_visit_id for update;
  if not found then
    raise exception 'приём % не найден', p_visit_id using errcode = 'P0002';
  end if;

  -- Идемпотентность живёт в БД, а не в приложении: обрыв мобильной сети между
  -- COMMIT и ответом — рядовое событие, когда врач закрывает приём в коридоре.
  -- Повтор обязан вернуть тот же снимок, а не списать второй раз.
  update visits
     set status = 'closed', closed_at = now()
   where id = p_visit_id and status = 'open';
  get diagnostics closed_rows = row_count;

  if closed_rows = 0 then
    select * into existing from visit_costs
     where visit_id = p_visit_id and superseded_at is null;
    if found then
      return jsonb_build_object(
        'status', 'already_closed',
        'visitCostId', existing.id,
        'materialsTotal', existing.materials_total::text,
        'hasUnpriced', existing.has_unpriced,
        'unpricedLinesCount', existing.unpriced_lines_count,
        'total', existing.total::text
      );
    end if;
    raise exception 'приём % закрыт, но снимок себестоимости отсутствует', p_visit_id
      using errcode = 'P0001';
  end if;

  -- Блокировка затронутых партий в детерминированном порядке по id — против
  -- взаимоблокировки при одновременном закрытии двух приёмов.
  for rec in
    select (c->>'batchId')::uuid as batch_id,
           sum((c->>'qty')::numeric)              as total_taken,
           min((c->>'expectedQtyRemaining')::numeric) as expected
      from jsonb_array_elements(p_allocation->'consumptions') c
     group by 1
     order by 1
  loop
    select * into b from batches where id = rec.batch_id for update;
    if not found then
      raise exception 'партия % не найдена', rec.batch_id using errcode = 'P0002';
    end if;

    -- Оптимистическая сверка: между RTT 1 и RTT 2 партию мог израсходовать
    -- другой приём. Расхождение версии откатывает применение ЦЕЛИКОМ.
    if b.qty_remaining <> rec.expected then
      raise exception
        'конфликт версии партии %: ожидалось %, фактически %',
        rec.batch_id, rec.expected, b.qty_remaining
        using errcode = '40001';
    end if;
    if rec.total_taken > b.qty_remaining then
      raise exception 'партия %: попытка списать % при остатке %',
        rec.batch_id, rec.total_taken, b.qty_remaining using errcode = 'P0001';
    end if;

    update batches set qty_remaining = qty_remaining - rec.total_taken
     where id = rec.batch_id;
  end loop;

  insert into stock_movements
    (tenant_id, location_id, visit_id, kind, batch_id, material_id, qty_delta, cost, unpriced)
  select v.tenant_id, v.location_id, v.id, 'consume',
         (c->>'batchId')::uuid, (c->>'materialId')::uuid,
         -((c->>'qty')::numeric),
         case when c->>'cost' is null then null else (c->>'cost')::numeric end,
         (c->>'cost') is null
    from jsonb_array_elements(p_allocation->'consumptions') c;

  -- Недостача — строка движения, а не отказ. Закрытие приёма нельзя отвергнуть
  -- по причине остатка: услуга уже оказана, это клинический факт.
  insert into stock_movements
    (tenant_id, location_id, visit_id, kind, batch_id, material_id, qty_delta, cost, unpriced, shortfall_state)
  select v.tenant_id, v.location_id, v.id, 'shortfall',
         null, (s->>'materialId')::uuid,
         -((s->>'qty')::numeric),
         case when s->>'cost' is null then null else (s->>'cost')::numeric end,
         (s->>'cost') is null,
         'open'
    from jsonb_array_elements(p_allocation->'shortfalls') s;

  insert into visit_costs
    (tenant_id, visit_id, materials_total, has_unpriced, unpriced_lines_count, direct_costs, total)
  values (
    v.tenant_id, v.id,
    (p_allocation->>'materialsTotal')::numeric,
    (p_allocation->>'unpricedLinesCount')::int > 0,
    (p_allocation->>'unpricedLinesCount')::int,
    0,
    (p_allocation->>'materialsTotal')::numeric
  )
  returning id into cost_id;

  return jsonb_build_object(
    'status', 'closed',
    'visitCostId', cost_id,
    'materialsTotal', (p_allocation->>'materialsTotal'),
    'hasUnpriced', (p_allocation->>'unpricedLinesCount')::int > 0,
    'unpricedLinesCount', (p_allocation->>'unpricedLinesCount')::int,
    'total', (p_allocation->>'materialsTotal')
  );
end $$;

revoke all on function get_close_context(uuid) from public, anon, authenticated;
revoke all on function apply_visit_close(uuid, jsonb) from public, anon, authenticated;
