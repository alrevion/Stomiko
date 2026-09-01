-- 028_demo_history_backfill (применена 20260828163741)

-- 028: демо-история, похожая на живой кабинет.
--
-- Было: 165 приёмов, 165 пациентов, ни одного повторного визита и ни одной
-- записи в календаре за прошлый месяц. Врач, листающий назад, видел пустоту,
-- хотя отчёт по марже считался по 164 приёмам. И ни у кого не было истории —
-- а «что я делал этому человеку в прошлый раз» стоматолог спрашивает чаще
-- всего остального.
do $$
declare
  t uuid; chair uuid;
  regulars uuid[]; v record; target uuid; i int := 0;
  cur_date date := null; cursor_ts timestamptz; dur int; aid uuid;
  lunch_from time := '13:00'; lunch_to time := '14:00';
begin
  select id into t from tenants limit 1;
  select id into chair from resources where tenant_id = t and kind = 'chair' limit 1;

  -- Постоянные пациенты: у кабинета, работающего год, половина потока — свои.
  select array_agg(id) into regulars from (
    select p.id from patients p
     where p.tenant_id = t and p.full_name <> '— занято —'
     order by p.created_at limit 55) q;

  for v in
    select vi.id, vi.visit_date, vi.patient_id
      from visits vi where vi.tenant_id = t order by vi.visit_date, vi.id
  loop
    i := i + 1;
    -- Каждый третий приём отдаём постоянному пациенту, если он в этот день
    -- ещё не приходил: два визита одного человека в один день — не история,
    -- а ошибка ввода.
    if i % 3 = 0 then
      target := regulars[1 + (i / 3) % array_length(regulars, 1)];
      if target <> v.patient_id and not exists (
        select 1 from visits x where x.patient_id = target and x.visit_date = v.visit_date)
      then
        update visits set patient_id = target where id = v.id;
      end if;
    end if;
  end loop;

  -- Пациенты, у которых после слияния не осталось ни приёмов, ни записей.
  delete from patients p
   where p.tenant_id = t
     and p.full_name <> '— занято —'
     and not exists (select 1 from visits x where x.patient_id = p.id)
     and not exists (select 1 from appointments a where a.patient_id = p.id);

  -- Записи под уже состоявшиеся приёмы: без них календарь за прошлый месяц пуст.
  -- Даты с 26 августа не трогаем — там живут записи текущей недели.
  for v in
    select vi.id, vi.visit_date, vi.patient_id,
           (select vs.service_id from visit_services vs where vs.visit_id = vi.id
             order by vs.price desc limit 1) as service_id,
           (select coalesce(max(s.duration_minutes), 30)
              from visit_services vs join services s on s.id = vs.service_id
             where vs.visit_id = vi.id) as minutes
      from visits vi
     where vi.tenant_id = t and vi.appointment_id is null and vi.visit_date < date '2026-08-26'
     order by vi.visit_date, vi.id
  loop
    if cur_date is distinct from v.visit_date then
      cur_date := v.visit_date;
      cursor_ts := (v.visit_date + time '09:00') at time zone 'Asia/Tashkent';
    end if;

    dur := greatest(15, v.minutes);

    -- Обед не занимаем: расписание кабинета 09–13 и 14–18.
    if (cursor_ts at time zone 'Asia/Tashkent')::time < lunch_to
       and ((cursor_ts + make_interval(mins => dur)) at time zone 'Asia/Tashkent')::time > lunch_from then
      cursor_ts := (v.visit_date + lunch_to) at time zone 'Asia/Tashkent';
    end if;

    -- Что не поместилось в день, остаётся без записи: выдуманные приёмы
    -- до полуночи выглядели бы хуже, чем их отсутствие. Такой приём всё равно
    -- доступен из карточки пациента.
    continue when ((cursor_ts + make_interval(mins => dur)) at time zone 'Asia/Tashkent')::time > time '19:30';

    insert into appointments (tenant_id, patient_id, service_id, starts_at, ends_at, status, source, note)
      values (t, v.patient_id, v.service_id, cursor_ts, cursor_ts + make_interval(mins => dur),
              'done', 'staff', null)
      returning id into aid;
    insert into appointment_resources (tenant_id, appointment_id, resource_id, role, starts_at, ends_at)
      values (t, aid, chair, 'chair', cursor_ts, cursor_ts + make_interval(mins => dur));
    update visits set appointment_id = aid where id = v.id;

    cursor_ts := cursor_ts + make_interval(mins => dur + 5);
  end loop;

  -- Прошедшие записи, по которым приёма так и не было. Одну оставляем как
  -- «не пришёл» — неявка у стоматолога обычная вещь, и статус должен быть
  -- виден. Остальные — мусор от наполнения, он бы вечно висел «предстоит».
  update appointments set status = 'no_show'
   where id = (select a.id from appointments a
                where a.tenant_id = t and a.status = 'scheduled' and a.starts_at < now()
                  and not exists (select 1 from visits x where x.appointment_id = a.id)
                  and a.patient_id <> (select id from patients where tenant_id = t and full_name = '— занято —')
                order by a.starts_at limit 1);
  delete from appointment_resources ar
   where ar.appointment_id in (
     select a.id from appointments a
      where a.tenant_id = t and a.status in ('scheduled','no_show') and a.starts_at < now()
        and not exists (select 1 from visits x where x.appointment_id = a.id));
  delete from appointments a
   where a.tenant_id = t and a.status = 'scheduled' and a.starts_at < now()
     and not exists (select 1 from visits x where x.appointment_id = a.id)
     and a.patient_id <> (select id from patients where tenant_id = t and full_name = '— занято —');
end $$;;
