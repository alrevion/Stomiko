-- 054b_treatment_plan_functions

-- Продолжение 054a: чтение и запись плана, деньги, автозакрытие пунктов
-- и то, что из всего этого видит пациент.

/* ── План: чтение ────────────────────────────────────────────────────── */

/** Позиции плана с прогнозной себестоимостью. Только для врача. */
create or replace function public.treatment_plan(p_tenant_id uuid, p_plan_id uuid)
returns jsonb
language sql stable security definer set search_path to 'public','extensions' as $$
  with p as (
    select * from treatment_plans where id = p_plan_id and tenant_id = p_tenant_id
  ),
  it as (
    select i.*, s.name_ru, s.unit_of_norm, c.cost, c.unpriced_lines
      from treatment_plan_items i
      join p on p.id = i.plan_id
      join services s on s.id = i.service_id
      cross join lateral public.service_expected_cost(p_tenant_id, i.service_id, i.quantity) c
  )
  select case when not exists (select 1 from p) then null else jsonb_build_object(
    'id',        (select id from p),
    'title',     (select title from p),
    'status',    (select status from p),
    'note',      (select note from p),
    'createdAt', (select created_at from p),
    'patient',   (select jsonb_build_object('id', pt.id, 'name', pt.full_name, 'phone', pt.phone)
                    from patients pt where pt.id = (select patient_id from p)),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', it.id, 'serviceId', it.service_id, 'service', it.name_ru,
               'unit', it.unit_of_norm, 'tooth', it.tooth, 'quantity', it.quantity,
               'price', it.price, 'stage', it.stage, 'status', it.status,
               'cost', it.cost, 'unpricedLines', it.unpriced_lines,
               'doneAt', it.done_at)
             order by it.stage, it.position, it.created_at)
        from it), '[]'::jsonb),
    'totals', (
      select jsonb_build_object(
        'revenue',       coalesce(sum(price) filter (where status <> 'cancelled'), 0),
        'cost',          coalesce(sum(cost)  filter (where status <> 'cancelled'), 0),
        'margin',        coalesce(sum(price) filter (where status <> 'cancelled'), 0)
                       - coalesce(sum(cost)  filter (where status <> 'cancelled'), 0),
        'doneRevenue',   coalesce(sum(price) filter (where status = 'done'), 0),
        'leftRevenue',   coalesce(sum(price) filter (where status = 'planned'), 0),
        'unpricedLines', coalesce(sum(unpriced_lines) filter (where status <> 'cancelled'), 0),
        'stages',        coalesce(count(distinct stage) filter (where status <> 'cancelled'), 0))
      from it)
  ) end;
$$;

/** Планы пациента списком — с итогами, но без разбора по позициям. */
create or replace function public.patient_plans(p_tenant_id uuid, p_patient_id uuid)
returns table (id uuid, title text, status text, created_at timestamptz,
               items int, done int, revenue numeric, cost numeric)
language sql stable security definer set search_path to 'public','extensions' as $$
  select pl.id, pl.title, pl.status, pl.created_at,
         count(i.*) filter (where i.status <> 'cancelled')::int,
         count(i.*) filter (where i.status = 'done')::int,
         coalesce(sum(i.price) filter (where i.status <> 'cancelled'), 0),
         coalesce(sum(c.cost)  filter (where i.status <> 'cancelled'), 0)
    from treatment_plans pl
    left join treatment_plan_items i on i.plan_id = pl.id
    left join lateral public.service_expected_cost(p_tenant_id, i.service_id, i.quantity) c on true
   where pl.tenant_id = p_tenant_id and pl.patient_id = p_patient_id
   group by pl.id
   order by pl.created_at desc;
$$;


/* ── План: запись ────────────────────────────────────────────────────── */

/**
 * Сохранение плана целиком.
 *
 * Выполненные позиции не трогаются: они связаны с оказанными услугами, и
 * переписать их правкой плана значило бы задним числом изменить историю
 * лечения. Заменяются только запланированные.
 */
create or replace function public.save_treatment_plan(
  p_tenant_id uuid, p_plan_id uuid, p_patient_id uuid,
  p_title text, p_status text, p_note text, p_items jsonb, p_by text default null
) returns jsonb
language plpgsql volatile security definer set search_path to 'public','extensions' as $$
declare pid uuid; bad text; n int;
begin
  if coalesce(trim(p_title), '') = '' then
    raise exception 'у плана должно быть название' using errcode='P0001';
  end if;
  if p_status is not null and p_status not in ('draft','active','done','cancelled') then
    raise exception 'неизвестный статус плана' using errcode='P0001';
  end if;

  if p_plan_id is null then
    if not exists (select 1 from patients where id = p_patient_id and tenant_id = p_tenant_id) then
      raise exception 'пациент не найден' using errcode='P0002';
    end if;
    insert into treatment_plans (tenant_id, patient_id, title, status, note, created_by)
      values (p_tenant_id, p_patient_id, trim(p_title), coalesce(p_status,'draft'), p_note, p_by)
      returning id into pid;
  else
    update treatment_plans
       set title = trim(p_title),
           status = coalesce(p_status, status),
           note = p_note,
           closed_at = case when coalesce(p_status, status) in ('done','cancelled')
                            then coalesce(closed_at, now()) else null end
     where id = p_plan_id and tenant_id = p_tenant_id
     returning id into pid;
    if pid is null then raise exception 'план не найден' using errcode='P0002'; end if;
  end if;

  -- Услуги должны быть из этого же кабинета: идентификатор приходит из
  -- запроса, а не из справочника, который мы отдали.
  select string_agg(x.sid::text, ', ') into bad
    from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) e
    cross join lateral (select (e->>'serviceId')::uuid as sid) x
   where not exists (select 1 from services s where s.id = x.sid and s.tenant_id = p_tenant_id);
  if bad is not null then
    raise exception 'услуга не из этого кабинета: %', bad using errcode='P0001';
  end if;

  delete from treatment_plan_items where plan_id = pid and status = 'planned';

  insert into treatment_plan_items
    (tenant_id, plan_id, service_id, tooth, quantity, price, stage, position)
  select p_tenant_id, pid, (e->>'serviceId')::uuid,
         nullif(trim(coalesce(e->>'tooth','')), ''),
         greatest(coalesce((e->>'quantity')::int, 1), 1),
         -- Цена по умолчанию — прайсовая: план собирается из прайса, и
         -- перебивать её руками нужно только когда врач делает скидку.
         coalesce((e->>'price')::numeric,
                  (select s.price from services s where s.id = (e->>'serviceId')::uuid)),
         greatest(coalesce((e->>'stage')::int, 1), 1),
         (ord - 1)::int
    from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) with ordinality as t(e, ord);
  get diagnostics n = row_count;

  return jsonb_build_object('planId', pid, 'items', n);
end $$;

create or replace function public.delete_treatment_plan(p_tenant_id uuid, p_plan_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path to 'public','extensions' as $$
declare done int;
begin
  select count(*) into done from treatment_plan_items
   where plan_id = p_plan_id and tenant_id = p_tenant_id and status = 'done';
  if done > 0 then
    -- Удалить план, часть которого уже выполнена, — значит потерять связь
    -- между оказанным и задуманным. Такой план закрывают, а не стирают.
    raise exception 'по плану уже есть выполненные работы — закройте его, а не удаляйте'
      using errcode='P0001';
  end if;
  delete from treatment_plans where id = p_plan_id and tenant_id = p_tenant_id;
  if not found then raise exception 'план не найден' using errcode='P0002'; end if;
  return jsonb_build_object('deleted', true);
end $$;


/* ── Деньги ──────────────────────────────────────────────────────────── */

/**
 * Сколько пациент должен.
 *
 * Начисляется по ЗАКРЫТЫМ приёмам: открытый приём ещё правится, и считать
 * долгом то, что врач сейчас набирает, — значит показывать пациенту цифру,
 * которая изменится через минуту.
 */
create or replace function public.patient_balance(p_tenant_id uuid, p_patient_id uuid)
returns jsonb
language sql stable security definer set search_path to 'public','extensions' as $$
  select jsonb_build_object(
    'billed', b.billed, 'paid', pd.paid, 'debt', b.billed - pd.paid)
    from (select coalesce(sum(vs.price), 0) as billed
            from visit_services vs join visits v on v.id = vs.visit_id
           where v.tenant_id = p_tenant_id and v.patient_id = p_patient_id
             and v.status = 'closed') b
   cross join (select coalesce(sum(amount), 0) as paid from payments
                where tenant_id = p_tenant_id and patient_id = p_patient_id) pd;
$$;

create or replace function public.record_payment(
  p_tenant_id uuid, p_patient_id uuid, p_amount numeric,
  p_method text default 'cash', p_note text default null, p_by text default null
) returns jsonb
language plpgsql volatile security definer set search_path to 'public','extensions' as $$
declare pid uuid;
begin
  if not exists (select 1 from patients where id = p_patient_id and tenant_id = p_tenant_id) then
    raise exception 'пациент не найден' using errcode='P0002';
  end if;
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'сумма должна быть больше нуля' using errcode='P0001';
  end if;
  insert into payments (tenant_id, patient_id, amount, method, note, received_by)
    values (p_tenant_id, p_patient_id, round(p_amount, 2), coalesce(p_method,'cash'), p_note, p_by)
    returning id into pid;
  return jsonb_build_object('paymentId', pid,
    'balance', public.patient_balance(p_tenant_id, p_patient_id));
end $$;

create or replace function public.patient_payments(p_tenant_id uuid, p_patient_id uuid)
returns table (id uuid, amount numeric, method text, note text, created_at timestamptz)
language sql stable security definer set search_path to 'public','extensions' as $$
  select id, amount, method, note, created_at from payments
   where tenant_id = p_tenant_id and patient_id = p_patient_id
   order by created_at desc;
$$;


/* ── Пункты плана закрываются сами ───────────────────────────────────── */

/**
 * Оказанная услуга закрывает пункт плана.
 *
 * Триггером, а не внутри apply_visit_close: закрытие приёма — состояние,
 * а не единственный маршрут, и учёт выполнения плана обязан идти за
 * состоянием, откуда бы его ни поменяли.
 *
 * Сопоставление только по услуге. Зуб в visit_services не хранится, и
 * угадывать по нему было бы хуже, чем не угадывать: пункт закрылся бы не тот.
 * Один оказанный — один пункт: повторная услуга закроет второй пункт, а не
 * тот же самый дважды.
 */
create or replace function public.tg_close_plan_items() returns trigger
language plpgsql security definer set search_path to 'public','extensions' as $$
declare vs record;
begin
  for vs in select * from visit_services where visit_id = new.id order by created_at, id loop
    update treatment_plan_items i
       set status = 'done', done_at = now(), visit_service_id = vs.id
     where i.id = (
       select i2.id from treatment_plan_items i2
         join treatment_plans pl on pl.id = i2.plan_id
        where pl.tenant_id = new.tenant_id
          and pl.patient_id = new.patient_id
          and pl.status = 'active'
          and i2.status = 'planned'
          and i2.service_id = vs.service_id
        order by i2.stage, i2.position, i2.created_at
        limit 1);
  end loop;

  -- План, в котором не осталось незакрытых работ, закрывается сам: держать
  -- его «активным» значит показывать пациенту вечно незавершённое лечение.
  update treatment_plans pl
     set status = 'done', closed_at = now()
   where pl.tenant_id = new.tenant_id and pl.patient_id = new.patient_id
     and pl.status = 'active'
     and not exists (select 1 from treatment_plan_items i
                      where i.plan_id = pl.id and i.status = 'planned');
  return null;
end $$;

create trigger visits_close_plan_items
  after update of status on visits
  for each row when (new.status = 'closed' and old.status is distinct from 'closed')
  execute function public.tg_close_plan_items();


/* ── Что видит пациент ───────────────────────────────────────────────── */

/**
 * План лечения в руках пациента.
 *
 * Ключ — subject из Telegram, как у my_appointments: человек получает свои
 * планы по всем кабинетам и ничьи больше.
 *
 * Себестоимости и маржи здесь НЕТ и быть не может. Это не настройка показа,
 * а граница: пациенту отдаётся другой набор полей, а не тот же с погашенными
 * колонками. Черновики тоже не отдаются — недособранный план читается как
 * обещание, которого врач не давал.
 */
create or replace function public.my_treatment_plans(p_subject text)
returns jsonb
language sql stable security definer set search_path to 'public','extensions' as $$
  select coalesce(jsonb_agg(x order by x->>'createdAt' desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', pl.id, 'cabinet', t.name, 'title', pl.title, 'status', pl.status,
      'createdAt', pl.created_at,
      'total', coalesce((select sum(i.price) from treatment_plan_items i
                          where i.plan_id = pl.id and i.status <> 'cancelled'), 0),
      'donePart', coalesce((select sum(i.price) from treatment_plan_items i
                             where i.plan_id = pl.id and i.status = 'done'), 0),
      'balance', public.patient_balance(pl.tenant_id, pl.patient_id),
      'stages', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'stage', g.stage, 'items', g.items) order by g.stage)
          from (select i.stage,
                       jsonb_agg(jsonb_build_object(
                         'service', s.name_ru, 'tooth', i.tooth,
                         'quantity', i.quantity, 'price', i.price, 'status', i.status)
                       order by i.position, i.created_at) as items
                  from treatment_plan_items i
                  join services s on s.id = i.service_id
                 where i.plan_id = pl.id and i.status <> 'cancelled'
                 group by i.stage) g), '[]'::jsonb)
    ) as x
      from treatment_plans pl
      join patients p on p.id = pl.patient_id
      join tenants  t on t.id = pl.tenant_id
     where p.telegram_subject = p_subject
       and pl.status in ('active','done')
  ) q;
$$;


