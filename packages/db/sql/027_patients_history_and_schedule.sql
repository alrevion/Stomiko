-- 027_patients_history_and_schedule (применена 20260828163645)

alter table appointments drop constraint appointments_status_check;
alter table appointments add constraint appointments_status_check
  check (status = any (array['scheduled','cancelled','done','no_show']));

create or replace function public.visit_detail(p_visit_id uuid)
returns jsonb
language sql stable security definer set search_path to 'public','extensions'
as $$
  select jsonb_build_object(
    'id', v.id,
    'status', v.status,
    'visitDate', v.visit_date,
    'closedAt', v.closed_at,
    'patientId', p.id,
    'patient', p.full_name,
    'phone', p.phone,
    'appointmentId', v.appointment_id,
    'services', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', vs.id, 'name', s.name_ru, 'quantity', vs.quantity, 'price', vs.price)
               order by s.name_ru)
        from visit_services vs join services s on s.id = vs.service_id
       where vs.visit_id = v.id), '[]'::jsonb),
    'revenue', coalesce((select sum(vs.price) from visit_services vs where vs.visit_id = v.id), 0),
    'cost', (select vc.materials_total from visit_costs vc
              where vc.visit_id = v.id and vc.superseded_at is null),
    'hasUnpriced', coalesce((select vc.has_unpriced from visit_costs vc
              where vc.visit_id = v.id and vc.superseded_at is null), false)
  )
  from visits v join patients p on p.id = v.patient_id
  where v.id = p_visit_id;
$$;

create or replace function public.patients_overview(
  p_tenant_id uuid, p_query text default '', p_limit int default 60)
returns table(
  id uuid, full_name text, phone text, visits bigint, last_visit date,
  total_revenue numeric, next_at timestamptz, in_telegram boolean)
language sql stable security definer set search_path to 'public','extensions'
as $$
  select p.id, p.full_name, p.phone,
         count(distinct v.id) as visits,
         max(v.visit_date) as last_visit,
         coalesce(sum(vs.price), 0) as total_revenue,
         (select min(a.starts_at) from appointments a
           where a.patient_id = p.id and a.status = 'scheduled' and a.starts_at >= now()),
         p.telegram_subject is not null
    from patients p
    left join visits v on v.patient_id = p.id
    left join visit_services vs on vs.visit_id = v.id
   where p.tenant_id = p_tenant_id
     and p.full_name <> '— занято —'
     and (coalesce(trim(p_query), '') = ''
          or p.full_name ilike '%' || trim(p_query) || '%'
          or coalesce(p.phone, '') ilike '%' || trim(p_query) || '%')
   group by p.id
   order by ((select min(a.starts_at) from appointments a
               where a.patient_id = p.id and a.status = 'scheduled' and a.starts_at >= now()) is null),
            max(v.visit_date) desc nulls last, p.full_name
   limit greatest(1, least(p_limit, 200));
$$;

create or replace function public.patient_card(p_tenant_id uuid, p_patient_id uuid)
returns jsonb
language sql stable security definer set search_path to 'public','extensions'
as $$
  select jsonb_build_object(
    'id', p.id, 'name', p.full_name, 'phone', p.phone, 'notes', p.notes,
    'inTelegram', p.telegram_subject is not null,
    'since', p.created_at,
    'appointments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'startsAt', a.starts_at, 'status', a.status,
               'service', s.name_ru, 'note', a.note, 'cancelReason', a.cancel_reason)
               order by a.starts_at desc)
        from appointments a left join services s on s.id = a.service_id
       where a.patient_id = p.id), '[]'::jsonb),
    'visits', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', v.id, 'date', v.visit_date, 'status', v.status,
               'revenue', (select coalesce(sum(vs.price),0) from visit_services vs where vs.visit_id = v.id),
               'cost', (select vc.materials_total from visit_costs vc
                         where vc.visit_id = v.id and vc.superseded_at is null),
               'services', (select coalesce(jsonb_agg(s2.name_ru || case when vs2.quantity > 1
                                     then ' x' || vs2.quantity else '' end order by s2.name_ru), '[]'::jsonb)
                              from visit_services vs2 join services s2 on s2.id = vs2.service_id
                             where vs2.visit_id = v.id))
               order by v.visit_date desc)
        from visits v where v.patient_id = p.id), '[]'::jsonb)
  )
  from patients p
  where p.id = p_patient_id and p.tenant_id = p_tenant_id;
$$;

create or replace function public.save_schedule(
  p_tenant_id uuid, p_resource_id uuid, p_hours jsonb, p_settings jsonb default null)
returns jsonb
language plpgsql security definer set search_path to 'public','extensions'
as $$
declare h jsonb; n int := 0;
begin
  for h in select * from jsonb_array_elements(coalesce(p_hours, '[]'::jsonb)) loop
    if (h->>'weekday')::int not between 0 and 6 then
      raise exception 'неверный день недели' using errcode='P0001';
    end if;
    if (h->>'endsAt')::time <= (h->>'startsAt')::time then
      raise exception '% - %: конец раньше начала', h->>'startsAt', h->>'endsAt' using errcode='P0001';
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
  select p_tenant_id, p_resource_id, (h->>'weekday')::int,
         (h->>'startsAt')::time, (h->>'endsAt')::time
    from jsonb_array_elements(coalesce(p_hours,'[]'::jsonb)) h;
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
end $$;

create or replace function public.mark_no_show(p_appointment_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public','extensions'
as $$
declare a appointments%rowtype;
begin
  select * into a from appointments where id = p_appointment_id for update;
  if not found then raise exception 'запись не найдена' using errcode='P0002'; end if;
  if a.starts_at > now() then
    raise exception 'приём ещё не начался' using errcode='P0001';
  end if;
  if exists (select 1 from visits v where v.appointment_id = a.id) then
    raise exception 'по этой записи уже начат приём' using errcode='P0001';
  end if;
  update appointments set status = 'no_show' where id = p_appointment_id;
  delete from appointment_resources where appointment_id = p_appointment_id;
  return jsonb_build_object('ok', true);
end $$;;
