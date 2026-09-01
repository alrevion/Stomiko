-- 043_seed_demo_data (применена 20260901113303)

-- 043: выдуманная работа для знакомства с кабинетом.
--
-- Готовит ВСЁ, кроме закрытия приёмов: закрытие идёт распределителем на
-- стороне воркера, тем же самым, что считает настоящую себестоимость.
-- Переписать его в SQL значило бы завести вторую реализацию денежного пути,
-- и однажды они разошлись бы — а разойдясь, показали бы врачу цифру,
-- которой в его кабинете нет.
--
-- Возвращает список приёмов, которые воркеру осталось закрыть.
create or replace function public.seed_demo_data(p_tenant_id uuid)
returns table(visit_id uuid)
language plpgsql security definer set search_path to 'public','extensions' as $$
declare
  loc uuid; chair uuid; d date; i int; n int;
  pid uuid; aid uuid; vid uuid; svc record; cursor_ts timestamptz;
  names text[] := array[
    'Азизов Санжар','Каримова Дилноза','Юсупов Тимур','Рахимова Нигора',
    'Тошматов Бекзод','Эргашева Феруза','Абдуллаев Отабек','Саидова Камола',
    'Умаров Даниёр','Носирова Зухра','Холматов Азиз','Исмоилова Малика'];
  notes text[] := array['болит при холодном','откололся край','плановый осмотр',
                        'кровит десна','выпала пломба', null];
begin
  select id into loc from locations where tenant_id = p_tenant_id limit 1;
  select id into chair from resources where tenant_id = p_tenant_id and kind = 'chair' limit 1;

  -- Склад: закупка на всё сразу, одной партией на материал. Иначе первый же
  -- приём упрётся в недостачу и покажет себестоимость, которой не бывает.
  insert into batches (tenant_id, location_id, material_id, initial_qty, qty_remaining,
                       total_price, price_estimated, expires_at, supplier, is_demo)
  select p_tenant_id, loc, m.id, 200, 200,
         coalesce(m.reference_price, 1000) * 200, false,
         current_date + 400, 'Демо-поставщик', true
    from materials m where m.tenant_id = p_tenant_id;

  insert into stock_movements (tenant_id, location_id, kind, batch_id, material_id,
                               qty_delta, cost, unpriced)
  select p_tenant_id, loc, 'receipt', b.id, b.material_id, b.initial_qty, b.total_price, false
    from batches b where b.tenant_id = p_tenant_id and b.is_demo;

  -- Пациенты.
  for i in 1 .. array_length(names, 1) loop
    insert into patients (tenant_id, full_name, phone, is_demo)
      values (p_tenant_id, names[i], '+9989' || lpad((10000000 + i * 7717)::text, 8, '0'), true);
  end loop;

  -- Прошедшие приёмы: десять рабочих дней назад, по одному-двум в день.
  i := 0;
  for d in select generate_series(current_date - 14, current_date - 1, '1 day')::date loop
    continue when extract(isodow from d) = 7;          -- воскресенье выходной
    cursor_ts := (d + time '09:30') at time zone 'Asia/Tashkent';
    n := 1 + (extract(day from d)::int % 2);           -- один или два за день
    for i in 1 .. n loop
      select s.id, s.duration_minutes, s.techcard_version_id, s.price
        into svc from services s
       where s.tenant_id = p_tenant_id and s.bookable
       order by md5(s.id::text || d::text) limit 1;
      continue when svc.techcard_version_id is null;

      select p.id into pid from patients p
       where p.tenant_id = p_tenant_id and p.is_demo
       order by md5(p.id::text || d::text || i::text) limit 1;

      insert into appointments (tenant_id, patient_id, service_id, starts_at, ends_at,
                                status, source, is_demo)
        values (p_tenant_id, pid, svc.id, cursor_ts,
                cursor_ts + make_interval(mins => svc.duration_minutes), 'done', 'staff', true)
        returning id into aid;
      insert into appointment_resources (tenant_id, appointment_id, resource_id, role, starts_at, ends_at)
        values (p_tenant_id, aid, chair, 'chair', cursor_ts,
                cursor_ts + make_interval(mins => svc.duration_minutes));

      insert into visits (tenant_id, location_id, appointment_id, patient_id, visit_date, is_demo)
        values (p_tenant_id, loc, aid, pid, d, true) returning id into vid;
      insert into visit_services (tenant_id, visit_id, service_id, quantity, price, techcard_version_id)
        values (p_tenant_id, vid, svc.id, 1, svc.price, svc.techcard_version_id);

      visit_id := vid; return next;
      cursor_ts := cursor_ts + make_interval(mins => svc.duration_minutes + 45);
    end loop;
  end loop;

  -- Записи впереди: календарь не должен быть пустым справа от сегодня.
  for d in select generate_series(current_date, current_date + 6, '1 day')::date loop
    continue when extract(isodow from d) in (6, 7);
    cursor_ts := (d + time '11:00') at time zone 'Asia/Tashkent';
    for i in 1 .. 2 loop
      select s.id, s.duration_minutes into svc from services s
       where s.tenant_id = p_tenant_id and s.bookable
       order by md5(s.id::text || d::text || i::text) limit 1;
      select p.id into pid from patients p
       where p.tenant_id = p_tenant_id and p.is_demo
       order by md5(p.id::text || i::text || d::text) limit 1;

      begin
        insert into appointments (tenant_id, patient_id, service_id, starts_at, ends_at,
                                  status, source, note, is_demo)
          values (p_tenant_id, pid, svc.id, cursor_ts,
                  cursor_ts + make_interval(mins => svc.duration_minutes), 'scheduled',
                  case when i = 1 then 'patient_link' else 'staff' end,
                  notes[1 + (extract(day from d)::int % array_length(notes, 1))], true)
          returning id into aid;
        insert into appointment_resources (tenant_id, appointment_id, resource_id, role, starts_at, ends_at)
          values (p_tenant_id, aid, chair, 'chair', cursor_ts,
                  cursor_ts + make_interval(mins => svc.duration_minutes));
      exception when exclusion_violation then
        null;   -- слот занят соседней записью, просто пропускаем
      end;
      cursor_ts := cursor_ts + make_interval(mins => svc.duration_minutes + 60);
    end loop;
  end loop;

  perform start_onboarding(p_tenant_id);
end $$;

create or replace function public.audit_tenant_guards()
returns table(имя text, аргументы text, причина text)
language sql stable security definer
set search_path to 'public','extensions','pg_catalog' as $$
  select p.proname::text, pg_get_function_arguments(p.oid),
         'достижима снаружи и не проверяет кабинет'
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef and p.prokind = 'f'
     and pg_get_function_arguments(p.oid) not like '%p_tenant_id%'
     and p.proname not in (
       'due_reminders', 'mark_reminded', 'redeem_staff_invite',
       'new_public_token', 'rotate_public_token', 'audit_tenant_guards',
       'touch_app_user', 'user_context', 'set_user_mode', 'my_appointments',
       'set_verified_phone', 'normalize_phone',
       'provision_tenant', 'available_templates', 'template_health'
     )
     and has_function_privilege('service_role', p.oid, 'execute')
   order by p.proname;
$$;;
