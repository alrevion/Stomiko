-- 030_fix_save_schedule_ambiguous_alias (применена 20260828164744)

-- Переменная цикла `h` и алиас `jsonb_array_elements(...) h` в одном теле
-- функции — это «column reference h is ambiguous» на КАЖДОМ сохранении.
-- Проверки отрабатывали и отвергали неверное, поэтому в тесте всё выглядело
-- живым: падало только валидное сохранение, то есть ровно то, что делает врач.
create or replace function public.save_schedule(
  p_tenant_id uuid, p_resource_id uuid, p_hours jsonb, p_settings jsonb default null)
returns jsonb
language plpgsql security definer set search_path to 'public','extensions'
as $$
declare hrow jsonb; n int := 0;
begin
  for hrow in select * from jsonb_array_elements(coalesce(p_hours, '[]'::jsonb)) loop
    if (hrow->>'weekday')::int not between 0 and 6 then
      raise exception 'неверный день недели' using errcode='P0001';
    end if;
    if (hrow->>'endsAt')::time <= (hrow->>'startsAt')::time then
      raise exception '% - %: конец раньше начала', hrow->>'startsAt', hrow->>'endsAt' using errcode='P0001';
    end if;
  end loop;

  if exists (
    select 1 from jsonb_array_elements(coalesce(p_hours,'[]'::jsonb)) a,
                  jsonb_array_elements(coalesce(p_hours,'[]'::jsonb)) b
     where a->>'weekday' = b->>'weekday' and a <> b
       and (a->>'startsAt')::time < (b->>'endsAt')::time
       and (b->>'startsAt')::time < (a->>'endsAt')::time
  ) then
    raise exception 'интервалы одного дня пересекаются' using errcode='P0001';
  end if;

  delete from working_hours where tenant_id = p_tenant_id and resource_id = p_resource_id;

  insert into working_hours (tenant_id, resource_id, weekday, starts_at, ends_at)
  select p_tenant_id, p_resource_id, (e->>'weekday')::int,
         (e->>'startsAt')::time, (e->>'endsAt')::time
    from jsonb_array_elements(coalesce(p_hours,'[]'::jsonb)) e;
  get diagnostics n = row_count;

  if p_settings is not null then
    insert into booking_settings (tenant_id, slot_step_minutes, min_notice_minutes, max_days_ahead, buffer_minutes)
    values (p_tenant_id,
            coalesce((p_settings->>'slotStepMinutes')::int, 15),
            coalesce((p_settings->>'minNoticeMinutes')::int, 120),
            coalesce((p_settings->>'maxDaysAhead')::int, 30),
            coalesce((p_settings->>'bufferMinutes')::int, 10))
    on conflict (tenant_id) do update set
      slot_step_minutes  = coalesce((p_settings->>'slotStepMinutes')::int,  booking_settings.slot_step_minutes),
      min_notice_minutes = coalesce((p_settings->>'minNoticeMinutes')::int, booking_settings.min_notice_minutes),
      max_days_ahead     = coalesce((p_settings->>'maxDaysAhead')::int,     booking_settings.max_days_ahead),
      buffer_minutes     = coalesce((p_settings->>'bufferMinutes')::int,    booking_settings.buffer_minutes);
  end if;

  return jsonb_build_object('days', n);
end $$;;
