-- 017_available_slots (применена 20260825102452)

-- Свободные слоты считаются на лету из правил, а не хранятся таблицей.
-- Хранимая сетка слотов расходится с реальностью в тот же миг, когда кто-то
-- записался, — а пациент обязан получить именно тот слот, который увидел.
create or replace function available_slots(
  p_tenant_id uuid,
  p_resource_id uuid,
  p_service_id uuid,
  p_from date,
  p_to date
) returns table (slot_start timestamptz, slot_end timestamptz, on_date date)
language plpgsql stable security definer set search_path = public, extensions
as $$
declare
  tz          text;
  st          booking_settings%rowtype;
  duration    int;
  d           date;
  horizon     date;
  earliest    timestamptz;
  iv          record;
  cur         timestamptz;
  iv_end      timestamptz;
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
      -- Разовая правка на дату побеждает недельное правило. Если день закрыт —
      -- строк не будет вовсе, и цикл его пропустит.
      with ovr as (
        select is_closed, starts_at, ends_at
          from schedule_overrides
         where tenant_id = p_tenant_id and resource_id = p_resource_id and on_date = d
      )
      select o.starts_at, o.ends_at
        from ovr o
       where not o.is_closed
      union all
      select w.starts_at, w.ends_at
        from working_hours w
       where w.tenant_id = p_tenant_id
         and w.resource_id = p_resource_id
         and w.weekday = extract(dow from d)::int
         and not exists (select 1 from ovr)
      order by 1
    loop
      cur    := (d + iv.starts_at) at time zone tz;
      iv_end := (d + iv.ends_at)   at time zone tz;

      while cur + make_interval(mins => duration) <= iv_end loop
        if cur >= earliest and not exists (
          -- Занятость берётся из строк занятости ресурса — тех самых, что
          -- защищены EXCLUDE-ограничением от пересечений.
          select 1 from appointment_resources ar
            join appointments a on a.id = ar.appointment_id
           where ar.resource_id = p_resource_id
             and a.status <> 'cancelled'
             and tstzrange(ar.starts_at, ar.ends_at + make_interval(mins => st.buffer_minutes))
                 && tstzrange(cur, cur + make_interval(mins => duration))
        ) then
          slot_start := cur;
          slot_end   := cur + make_interval(mins => duration);
          on_date    := d;
          return next;
        end if;
        cur := cur + make_interval(mins => st.slot_step_minutes);
      end loop;
    end loop;
    d := d + 1;
  end loop;
end $$;

revoke all on function available_slots(uuid,uuid,uuid,date,date) from public, anon, authenticated;


-- Запись пациента. Приём, занятость ресурса и карточка пациента создаются
-- одной транзакцией: EXCLUDE-ограничение внутри неё гарантирует, что два
-- пациента не займут один слот, даже если нажали «Записаться» одновременно.
create or replace function book_appointment(
  p_tenant_id uuid, p_resource_id uuid, p_service_id uuid,
  p_starts_at timestamptz, p_patient_name text, p_phone text,
  p_note text default null, p_source text default 'patient_link'
) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare
  duration int; ends timestamptz; pid uuid; aid uuid; loc uuid;
begin
  select duration_minutes into duration from services where id = p_service_id and tenant_id = p_tenant_id;
  if duration is null then raise exception 'услуга не найдена' using errcode='P0002'; end if;
  ends := p_starts_at + make_interval(mins => duration);

  select id into loc from locations where tenant_id = p_tenant_id limit 1;

  -- Повторная запись того же телефона не плодит карточки.
  if p_phone is not null then
    select id into pid from patients where tenant_id = p_tenant_id and phone = p_phone;
  end if;
  if pid is null then
    insert into patients (tenant_id, full_name, phone)
      values (p_tenant_id, coalesce(nullif(trim(p_patient_name),''), 'Пациент'), p_phone)
      returning id into pid;
  end if;

  insert into appointments (tenant_id, patient_id, starts_at, ends_at, source, service_id, note)
    values (p_tenant_id, pid, p_starts_at, ends, p_source, p_service_id, p_note)
    returning id into aid;

  -- Здесь и срабатывает защита от двойной записи: пересечение по ресурсу
  -- отвергается ограничением, вся транзакция откатывается.
  insert into appointment_resources (tenant_id, appointment_id, resource_id, role, starts_at, ends_at)
    values (p_tenant_id, aid, p_resource_id, 'chair', p_starts_at, ends);

  return jsonb_build_object(
    'appointmentId', aid, 'patientId', pid,
    'startsAt', p_starts_at, 'endsAt', ends, 'locationId', loc
  );
exception when exclusion_violation then
  raise exception 'слот уже занят' using errcode='23P01';
end $$;

revoke all on function book_appointment(uuid,uuid,uuid,timestamptz,text,text,text,text) from public, anon, authenticated;;
