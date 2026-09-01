-- 018_available_slots_fix_name_clash (применена 20260825102544)

drop function if exists available_slots(uuid,uuid,uuid,date,date);

-- Выходной параметр назывался on_date и перекрывал колонку
-- schedule_overrides.on_date внутри тела функции. Переименован в slot_date.
create or replace function available_slots(
  p_tenant_id uuid,
  p_resource_id uuid,
  p_service_id uuid,
  p_from date,
  p_to date
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

revoke all on function available_slots(uuid,uuid,uuid,date,date) from public, anon, authenticated;;
