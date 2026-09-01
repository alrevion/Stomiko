-- 023_cancel_with_reason_and_notify (применена 20260825104708)

-- Причина отмены обязательна, когда отменяет врач: пациент должен узнать не
-- «ваш приём отменён», а почему. Без причины это выглядит как неуважение
-- и стоит визита.
alter table appointments add column cancel_reason text;

drop function if exists cancel_appointment(uuid, text);

-- Возвращает данные для уведомления: кому писать и что писать.
-- Отправку делает воркер — у функции БД нет доступа к Bot API.
create or replace function cancel_appointment(
  p_appointment_id uuid, p_by text, p_reason text default null
) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare a appointments%rowtype; p patients%rowtype; svc text;
begin
  select * into a from appointments where id = p_appointment_id for update;
  if not found then raise exception 'запись не найдена' using errcode='P0002'; end if;
  if a.status = 'cancelled' then
    return jsonb_build_object('alreadyCancelled', true);
  end if;
  if exists (select 1 from visits v where v.appointment_id = a.id and v.status = 'closed') then
    raise exception 'приём уже закрыт, запись отменить нельзя' using errcode='P0001';
  end if;
  if p_by = 'врач' and coalesce(trim(p_reason),'') = '' then
    raise exception 'укажите причину отмены — её увидит пациент' using errcode='P0001';
  end if;

  select * into p from patients where id = a.patient_id;
  select name_ru into svc from services where id = a.service_id;

  update appointments
     set status = 'cancelled', cancel_reason = p_reason
   where id = p_appointment_id;
  -- Слот освобождается сразу: занятость выражена наличием строк, а не флагом.
  delete from appointment_resources where appointment_id = p_appointment_id;

  return jsonb_build_object(
    'alreadyCancelled', false,
    'cancelledBy', p_by,
    'reason', p_reason,
    'patientName', p.full_name,
    'patientPhone', p.phone,
    -- Уведомить можно только тех, кто записывался через Telegram.
    -- Остальным врач звонит — и приложение обязано это сказать прямо.
    'telegramSubject', p.telegram_subject,
    'serviceName', svc,
    'startsAt', a.starts_at
  );
end $$;

-- Кто занимает промежуток: показать врачу ДО того, как он займёт время.
-- Молча отменить чужую запись нельзя.
create or replace function appointments_in_range(
  p_tenant_id uuid, p_resource_id uuid, p_starts_at timestamptz, p_ends_at timestamptz
) returns table (
  appointment_id uuid, patient_name text, patient_phone text,
  telegram_subject text, service_name text, starts_at timestamptz, ends_at timestamptz
)
language sql stable security definer set search_path = public, extensions
as $$
  select a.id, p.full_name, p.phone, p.telegram_subject, s.name_ru, ar.starts_at, ar.ends_at
    from appointment_resources ar
    join appointments a on a.id = ar.appointment_id
    join patients p on p.id = a.patient_id
    left join services s on s.id = a.service_id
   where ar.tenant_id = p_tenant_id
     and ar.resource_id = p_resource_id
     and a.status <> 'cancelled'
     and tstzrange(ar.starts_at, ar.ends_at) && tstzrange(p_starts_at, p_ends_at)
   order by ar.starts_at;
$$;

revoke all on function cancel_appointment(uuid,text,text) from public, anon, authenticated;
revoke all on function appointments_in_range(uuid,uuid,timestamptz,timestamptz) from public, anon, authenticated;;
