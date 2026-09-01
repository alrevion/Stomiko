-- 054a_treatment_plan_tables

-- План лечения, оплаты и долг.
--
-- Ничего из этого в базе не было: `visit_services.price` — цена оказанной
-- услуги, а не факт оплаты, и слова «оплачено» схема не знала вовсе.
--
-- Счетов здесь нет намеренно. У кабинета на одно кресло счёт не существует
-- и в жизни, а сущность тянет за собой нумерацию, статусы, частичные оплаты
-- по счёту и сверку. Долг считается прямо: оказано минус внесено. Когда
-- дойдёт до фискального чека, он привяжется к платежу, а не к счёту.
--
-- Главное отличие плана от списка цен — вторая колонка. Каждая позиция это
-- услуга, у услуги есть техкарта, у техкарты — нормы расхода и цены
-- материалов. Значит план суммируется не только в выручку, но и в затраты:
-- врач видит заработок ДО того, как предложит план пациенту.


/* ── Таблицы ─────────────────────────────────────────────────────────── */

create table treatment_plans (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  title      text not null,
  -- draft виден только врачу: показывать пациенту недособранный план — то же
  -- самое, что показывать черновик сметы.
  status     text not null default 'draft'
               check (status in ('draft','active','done','cancelled')),
  note       text,
  created_by text,
  created_at timestamptz not null default now(),
  closed_at  timestamptz
);
create index treatment_plans_tenant_idx  on treatment_plans (tenant_id, patient_id);

create table treatment_plan_items (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  plan_id    uuid not null references treatment_plans(id) on delete cascade,
  service_id uuid not null references services(id) on delete restrict,
  -- Номер зуба по FDI: квадрант 1-8, зуб 1-8. Постоянные 11-48, молочные
  -- 51-85. Проверка здесь, а не в приложении: это граница системы, и «26»
  -- от «два-шесть» отличать должна база.
  tooth      text check (tooth is null or tooth ~ '^[1-8][1-8]$'),
  -- Как и в visit_services, это ЕДИНИЦА НОРМИРОВАНИЯ услуги, а не число
  -- зубов: моляр с тремя каналами при unit_of_norm='canal' даёт 3.
  quantity   int not null default 1 check (quantity >= 1),
  price      numeric(18,2) not null check (price >= 0),
  stage      int not null default 1 check (stage >= 1),
  position   int not null default 0,
  status     text not null default 'planned'
               check (status in ('planned','done','cancelled')),
  -- Чем именно пункт закрыт. Связь нужна не для красоты: без неё нельзя
  -- проверить, что план выполнен тем, что реально оказано.
  visit_service_id uuid references visit_services(id) on delete set null,
  done_at    timestamptz,
  created_at timestamptz not null default now(),
  check ((status = 'done') = (done_at is not null))
);
create index treatment_plan_items_plan_idx on treatment_plan_items (plan_id, stage, position);

create table payments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  patient_id  uuid not null references patients(id) on delete restrict,
  amount      numeric(18,2) not null check (amount > 0),
  method      text not null default 'cash'
                check (method in ('cash','card','transfer','other')),
  note        text,
  received_by text,
  created_at  timestamptz not null default now()
);
create index payments_tenant_patient_idx on payments (tenant_id, patient_id, created_at);


/* ── Изоляция: второй слой, тот же что у остальных таблиц (048) ──────── */

do $$
declare t text;
begin
  foreach t in array array['treatment_plans','treatment_plan_items','payments'] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I as restrictive for all to anon using (false)',
      t || '_deny_anon', t);
    execute format($f$
      create policy %I on %I for all to authenticated
        using      (tenant_id = nullif(auth.jwt() ->> 'tenant_id', '')::uuid)
        with check (tenant_id = nullif(auth.jwt() ->> 'tenant_id', '')::uuid)
    $f$, t || '_own_tenant', t);
  end loop;
end $$;


/* ── Себестоимость наперёд ───────────────────────────────────────────── */

/**
 * Цена единицы материала.
 *
 * Сперва — то, что реально лежит на полке: средняя по остаткам. Справочная
 * цена идёт следом, потому что она предположение, а партии — факт. Если нет
 * ни того, ни другого, ответ null: строка честно останется без цены, вместо
 * того чтобы занулиться и занизить себестоимость.
 */
create or replace function public.material_unit_price(p_material_id uuid)
returns numeric
language sql stable security definer set search_path to 'public','extensions' as $$
  select coalesce(
    (select sum(b.total_price) / nullif(sum(b.initial_qty), 0)
       from batches b
      where b.material_id = p_material_id
        and b.total_price is not null and b.qty_remaining > 0),
    (select m.reference_price from materials m where m.id = p_material_id)
  );
$$;

/**
 * Во что обойдётся услуга, которую ещё не оказали.
 *
 * Это ПРОГНОЗ, а не факт: margin_by_service считает по списанным движениям,
 * здесь же берутся нормы действующей техкарты и сегодняшние цены. Расходятся
 * они закономерно — на недостачах и на смене партий.
 *
 * Строки без цены не зануляются, а считаются отдельно: план, где половина
 * материалов неизвестной стоимости, обязан выглядеть неполным, а не дешёвым.
 */
create or replace function public.service_expected_cost(
  p_tenant_id uuid, p_service_id uuid, p_quantity int default 1
) returns table (cost numeric, unpriced_lines int)
language sql stable security definer set search_path to 'public','extensions' as $$
  with lines as (
    select te.norm_qty * (case when te.scales_with_quantity
                               then greatest(coalesce(p_quantity, 1), 1) else 1 end) as qty,
           coalesce(
             public.material_unit_price(te.material_id),
             -- У аналогов берём первый по приоритету, у которого цена вообще
             -- есть: именно его и предпочтёт распределитель при списании.
             (select public.material_unit_price(m.mid)
                from unnest(te.analog_material_ids) with ordinality as m(mid, ord)
               where public.material_unit_price(m.mid) is not null
               order by m.ord limit 1)
           ) as unit_price
      from techcard_expanded te
      join services s on s.techcard_version_id = te.techcard_version_id
     where s.id = p_service_id and s.tenant_id = p_tenant_id
  )
  select round(coalesce(sum(qty * unit_price) filter (where unit_price is not null), 0), 2),
         count(*) filter (where unit_price is null)::int
    from lines;
$$;


