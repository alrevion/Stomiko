-- 053_slots_ignoring_own_booking

-- Перенос «на полчаса вперёд» не работал.
--
-- available_slots считает занятым всё, что пересекается с любой действующей
-- бронью — включая ту самую запись, которую человек как раз и двигает.
-- Пациент с приёмом в 10:00–11:00 не видел ни 10:30, ни 10:15: их закрывал
-- он сам. А это самый частый перенос из всех.
--
-- Поэтому у расчёта появляется одно исключение: «не считай занятой вот эту
-- бронь». Значение по умолчанию — null, и для записи с нуля ничего не
-- меняется. Раньше то же самое достигалось снятием брони перед проверкой и
-- откатом при отказе; такой приём работает, но означает, что на долю секунды
-- слот свободен для всех.

drop function if exists public.available_slots(uuid,uuid,uuid,date,date);

create function public.available_slots(
  p_tenant_id uuid,
  p_resource_id uuid,
  p_service_id uuid,
  p_from date,
  p_to date,
  p_ignore_appointment uuid default null
) returns table (slot_start timestamptz, slot_end timestamptz, slot_date date)
language plpgsql stable security definer set search_path = public, extensions
as $$
declare
  tz text; st booking_settings%rowtype; duration int;
  d date; horizon date; earliest timestamptz;
  iv record; cur timestamptz; iv_end timestamptz;
begin
  select timezone into tz from tenants where id = p_tenant_id;
  if tz is null then raise exception 'кабинет % не найден', p_tenant_id using errcode='P0002'; end if;

  select * into st from booking_settings where tenant_id = p_tenant_id;
  if not found then
    st.slot_step_minutes := 15; st.min_notice_minutes := 120;
    st.max_days_ahead := 30;    st.buffer_minutes := 10;
  end if;

  select coalesce(s.duration_minutes, 30) into duration from services s where s.id = p_service_id;
  if duration is null then raise exception 'услуга % не найдена', p_service_id using errcode='P0002'; end if;

  earliest := now() + make_interval(mins => st.min_notice_minutes);
  horizon  := ((now() at time zone tz)::date) + st.max_days_ahead;
  d := greatest(p_from, (now() at time zone tz)::date);

  while d <= least(p_to, horizon) loop
    for iv in
      with ovr as (
        select so.is_closed, so.starts_at, so.ends_at
          from schedule_overrides so
         where so.tenant_id = p_tenant_id and so.resource_id = p_resource_id and so.on_date = d
      )
      select o.starts_at as s, o.ends_at as e from ovr o where not o.is_closed
      union all
      select w.starts_at, w.ends_at
        from working_hours w
       where w.tenant_id = p_tenant_id
         and w.resource_id = p_resource_id
         and w.weekday = extract(dow from d)::int
         and not exists (select 1 from ovr)
      order by 1
    loop
      cur    := (d + iv.s) at time zone tz;
      iv_end := (d + iv.e) at time zone tz;

      while cur + make_interval(mins => duration) <= iv_end loop
        if cur >= earliest and not exists (
          select 1 from appointment_resources ar
            join appointments a on a.id = ar.appointment_id
           where ar.resource_id = p_resource_id
             and a.status <> 'cancelled'
             and a.id is distinct from p_ignore_appointment
             and tstzrange(ar.starts_at, ar.ends_at + make_interval(mins => st.buffer_minutes))
                 && tstzrange(cur, cur + make_interval(mins => duration))
        ) then
          slot_start := cur;
          slot_end   := cur + make_interval(mins => duration);
          slot_date  := d;
          return next;
        end if;
        cur := cur + make_interval(mins => st.slot_step_minutes);
      end loop;
    end loop;
    d := d + 1;
  end loop;
end $$;


-- Та же поправка в проверке одиночного времени: она обязана отвечать ровно то
-- же, что показал список, иначе пациент видит слот и получает отказ по нему.
drop function if exists public.slot_is_offered(uuid,uuid,uuid,timestamptz);

create function public.slot_is_offered(
  p_tenant_id uuid, p_resource_id uuid, p_service_id uuid, p_starts_at timestamptz,
  p_ignore_appointment uuid default null
) returns boolean
language plpgsql stable security definer set search_path to 'public','extensions'
as $$
declare tz text; d date;
begin
  select timezone into tz from tenants where id = p_tenant_id;
  if tz is null then return false; end if;
  d := (p_starts_at at time zone tz)::date;
  return exists (
    select 1 from public.available_slots(
      p_tenant_id, p_resource_id, p_service_id, d, d, p_ignore_appointment) s
     where s.slot_start = p_starts_at
  );
end $$;


/**
 * Куда можно перенести именно эту запись.
 *
 * Кресло и услуга берутся у самой записи: человек двигает то, на что уже
 * записан, а не выбирает заново. Пациентский маршрут «слоты по услуге» здесь
 * не годится — он работает в активном кабинете, а перенести можно запись в
 * любом из тех, где человек лечится.
 */
create or replace function public.appointment_slots(
  p_tenant_id uuid, p_appointment_id uuid, p_from date, p_to date
) returns table (slot_start timestamptz, slot_end timestamptz, slot_date date)
language plpgsql stable security definer set search_path to 'public','extensions'
as $$
declare sid uuid; rid uuid;
begin
  select a.service_id into sid from appointments a
   where a.id = p_appointment_id and a.tenant_id = p_tenant_id;
  if sid is null then
    raise exception 'у записи нет услуги — время подбирает врач' using errcode='P0002';
  end if;
  select ar.resource_id into rid from appointment_resources ar
   where ar.appointment_id = p_appointment_id and ar.role = 'chair' limit 1;
  if rid is null then raise exception 'у записи нет кресла' using errcode='P0002'; end if;

  return query select s.slot_start, s.slot_end, s.slot_date
    from public.available_slots(p_tenant_id, rid, sid, p_from, p_to, p_appointment_id) s;
end $$;


-- Перенос больше не снимает бронь ради проверки: занятость правится на месте,
-- а собственная запись исключается из расчёта параметром.
create or replace function public.reschedule_appointment(
  p_tenant_id uuid, p_appointment_id uuid, p_starts_at timestamptz
) returns jsonb
language plpgsql volatile security definer set search_path to 'public','extensions'
as $$
declare
  a appointments%rowtype; p patients%rowtype; svc text;
  res uuid; dur interval; was timestamptz; ends timestamptz;
begin
  select * into a from appointments
   where id = p_appointment_id and tenant_id = p_tenant_id for update;
  if not found then raise exception 'запись не найдена' using errcode='P0002'; end if;
  if a.status <> 'scheduled' then
    raise exception 'перенести можно только предстоящую запись' using errcode='P0001';
  end if;
  if exists (select 1 from visits v where v.appointment_id = a.id and v.status = 'closed') then
    raise exception 'приём уже закрыт, перенести нельзя' using errcode='P0001';
  end if;
  if a.service_id is null then
    raise exception 'у записи нет услуги — время подбирает врач' using errcode='P0001';
  end if;

  select ar.resource_id into res from appointment_resources ar
   where ar.appointment_id = a.id and ar.role = 'chair' limit 1;
  if res is null then raise exception 'у записи нет кресла' using errcode='P0002'; end if;

  if not public.slot_is_offered(p_tenant_id, res, a.service_id, p_starts_at, a.id) then
    raise exception 'это время недоступно' using errcode='P0001';
  end if;

  -- Длительность берётся у самой записи, а не у услуги: врач мог поставить
  -- нестандартное время, и перенос — не повод молча это исправлять.
  dur  := a.ends_at - a.starts_at;
  was  := a.starts_at;
  ends := p_starts_at + dur;

  update appointments
     set starts_at = p_starts_at, ends_at = ends,
         -- Напоминания и подтверждение относились к старому времени.
         reminded_day_at = null, reminded_hour_at = null, confirmed_at = null
   where id = a.id;

  -- Строка занятости правится на месте: EXCLUDE сравнивает её с ЧУЖИМИ
  -- строками, сама с собой она не конфликтует.
  update appointment_resources
     set starts_at = p_starts_at, ends_at = ends
   where appointment_id = a.id;

  select * into p from patients where id = a.patient_id;
  select name_ru into svc from services where id = a.service_id;

  return jsonb_build_object(
    'appointmentId', a.id, 'wasAt', was, 'startsAt', p_starts_at, 'endsAt', ends,
    'patientName', p.full_name, 'patientPhone', p.phone,
    'telegramSubject', p.telegram_subject, 'serviceName', svc
  );
exception when exclusion_violation then
  raise exception 'слот уже занят' using errcode='23P01';
end $$;

revoke all on function public.available_slots(uuid,uuid,uuid,date,date,uuid)
  from public, anon, authenticated;
revoke all on function public.slot_is_offered(uuid,uuid,uuid,timestamptz,uuid)
  from public, anon, authenticated;
revoke all on function public.appointment_slots(uuid,uuid,date,date)
  from public, anon, authenticated;
