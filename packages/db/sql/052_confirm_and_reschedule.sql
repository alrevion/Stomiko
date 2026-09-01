-- 052_confirm_and_reschedule

-- Подтверждение приёма и перенос времени пациентом.
--
-- Напоминание, на которое нельзя ответить, — это уведомление в пустоту:
-- врач всё равно не знает, придёт человек или нет, и обзванивает всех
-- подряд. Кнопка под напоминанием превращает рассылку в обратную связь:
-- звонить нужно только тем, кто промолчал.
--
-- Перенос — отдельная операция, а не «отменить и записаться заново».
-- Между двумя действиями слот успевает уйти, и человек, который всего лишь
-- сдвигал время на час, остаётся без приёма вовсе.

alter table appointments add column confirmed_at timestamptz;


/**
 * Предлагали ли мы это время вообще.
 *
 * До сих пор запись проверялась только EXCLUDE-ограничением, то есть
 * «никто другой это время не занял». Всё остальное держалось на том, что
 * пациент выбирает из показанного списка. Список живёт в приложении, которое
 * может провисеть открытым до утра: тогда нажатие создаёт приём в прошлом,
 * и он молча появляется в ленте вчерашнего дня.
 *
 * available_slots уже знает про рабочие часы, выходные, запас по времени,
 * горизонт записи и занятость. Проверять здесь что-то отдельно значило бы
 * завести вторую версию тех же правил, которая разойдётся с первой.
 */
create or replace function public.slot_is_offered(
  p_tenant_id uuid, p_resource_id uuid, p_service_id uuid, p_starts_at timestamptz
) returns boolean
language plpgsql stable security definer set search_path to 'public','extensions'
as $$
declare tz text; d date;
begin
  select timezone into tz from tenants where id = p_tenant_id;
  if tz is null then return false; end if;
  d := (p_starts_at at time zone tz)::date;
  return exists (
    select 1 from public.available_slots(p_tenant_id, p_resource_id, p_service_id, d, d) s
     where s.slot_start = p_starts_at
  );
end $$;


/**
 * Пациент подтвердил, что придёт.
 *
 * Ключ — subject из Telegram, как у my_appointments: право даёт не знание
 * идентификатора записи, а принадлежность записи этому человеку. Сообщение
 * с кнопкой пересылается в два касания, и нажатие постороннего обязано
 * не менять ничего.
 *
 * Возвращает jsonb, а не падает исключением: отказ здесь — обычный ответ
 * боту, который надо показать человеку словами, а не ошибкой в журнале.
 */
create or replace function public.confirm_appointment(p_subject text, p_appointment_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path to 'public','extensions'
as $$
declare a appointments%rowtype; svc text; cab text;
begin
  select ap.* into a
    from appointments ap
    join patients p on p.id = ap.patient_id
   where ap.id = p_appointment_id
     and p.telegram_subject = p_subject;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_yours'); end if;

  select name_ru into svc from services where id = a.service_id;
  select name into cab from tenants where id = a.tenant_id;

  if a.status = 'cancelled' then
    return jsonb_build_object('ok', false, 'reason', 'cancelled', 'serviceName', svc, 'cabinet', cab);
  end if;
  if a.starts_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'past', 'serviceName', svc, 'cabinet', cab);
  end if;

  -- Повторное нажатие — не ошибка: сообщение остаётся в чате, и человек
  -- вправе ткнуть в него ещё раз. Отвечаем тем же, но говорим, что уже.
  if a.confirmed_at is not null then
    return jsonb_build_object('ok', true, 'already', true,
      'serviceName', svc, 'cabinet', cab, 'startsAt', a.starts_at);
  end if;

  update appointments set confirmed_at = now() where id = p_appointment_id;

  return jsonb_build_object('ok', true, 'already', false,
    'serviceName', svc, 'cabinet', cab, 'startsAt', a.starts_at);
end $$;


/**
 * Перенос записи на другое время.
 *
 * Двигается ТА ЖЕ строка, а не создаётся новая: история приёмов пациента
 * не должна распадаться на «отменённый» и «настоящий» из-за того, что
 * человек сдвинул время.
 *
 * Занятость снимается и ставится заново, а не правится на месте. Иначе
 * собственная старая бронь закрывала бы соседние слоты того же дня, и
 * перенос с 10:00 на 10:30 отвергался бы как «время недоступно» —
 * записью самого же пациента.
 */
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
  if res is null then
    raise exception 'у записи нет кресла' using errcode='P0002';
  end if;

  -- Длительность берётся у самой записи, а не у услуги: врач мог поставить
  -- нестандартное время, и перенос — не повод молча это исправлять.
  dur  := a.ends_at - a.starts_at;
  was  := a.starts_at;
  ends := p_starts_at + dur;

  delete from appointment_resources where appointment_id = a.id;

  if not public.slot_is_offered(p_tenant_id, res, a.service_id, p_starts_at) then
    -- Откат вернёт снятую занятость: запись останется на старом времени.
    raise exception 'это время недоступно' using errcode='P0001';
  end if;

  update appointments
     set starts_at = p_starts_at, ends_at = ends,
         -- Напоминания и подтверждение относились к старому времени.
         reminded_day_at = null, reminded_hour_at = null, confirmed_at = null
   where id = a.id;

  insert into appointment_resources (tenant_id, appointment_id, resource_id, role, starts_at, ends_at)
    values (p_tenant_id, a.id, res, 'chair', p_starts_at, ends);

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


-- Запись пациента теперь тоже сверяется со списком предложенного.
-- Тело — то же, что в 036, добавлена одна проверка: приложение могло
-- провисеть открытым, и выбранное в нём время давно перестало быть свободным.
create or replace function public.book_appointment(
  p_tenant_id uuid, p_resource_id uuid, p_service_id uuid,
  p_starts_at timestamptz, p_patient_name text, p_phone text,
  p_note text default null, p_source text default 'patient_link',
  p_subject text default null)
returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare
  duration int; ends timestamptz; pid uuid; aid uuid; loc uuid; norm text;
begin
  select duration_minutes into duration from services
   where id = p_service_id and tenant_id = p_tenant_id;
  if duration is null then raise exception 'услуга не найдена' using errcode='P0002'; end if;
  ends := p_starts_at + make_interval(mins => duration);
  norm := public.normalize_phone(p_phone);

  if not public.slot_is_offered(p_tenant_id, p_resource_id, p_service_id, p_starts_at) then
    raise exception 'это время недоступно' using errcode='P0001';
  end if;

  select id into loc from locations where tenant_id = p_tenant_id limit 1;

  if p_subject is not null then
    select id into pid from patients
     where tenant_id = p_tenant_id and telegram_subject = p_subject limit 1;
  end if;
  if pid is null and norm is not null then
    select id into pid from patients
     where tenant_id = p_tenant_id and public.normalize_phone(phone) = norm limit 1;
  end if;

  if pid is null then
    insert into patients (tenant_id, full_name, phone, telegram_subject)
      values (p_tenant_id, coalesce(nullif(trim(p_patient_name),''), 'Пациент'), norm, p_subject)
      returning id into pid;
  else
    update patients
       set telegram_subject = coalesce(telegram_subject, p_subject),
           phone = coalesce(public.normalize_phone(phone), norm),
           full_name = case when full_name in ('Пациент','Пациент без имени')
                            then coalesce(nullif(trim(p_patient_name),''), full_name)
                            else full_name end
     where id = pid;
  end if;

  insert into appointments (tenant_id, patient_id, starts_at, ends_at, source, service_id, note)
    values (p_tenant_id, pid, p_starts_at, ends, p_source, p_service_id, p_note)
    returning id into aid;

  insert into appointment_resources (tenant_id, appointment_id, resource_id, role, starts_at, ends_at)
    values (p_tenant_id, aid, p_resource_id, 'chair', p_starts_at, ends);

  return jsonb_build_object(
    'appointmentId', aid, 'patientId', pid,
    'startsAt', p_starts_at, 'endsAt', ends, 'locationId', loc
  );
exception when exclusion_violation then
  raise exception 'слот уже занят' using errcode='23P01';
end $$;


-- Записи пациента теперь несут отметку подтверждения: приложение показывает
-- её в списке, а врач — в ленте дня.
--
-- Через drop, а не replace: набор колонок в returns table изменился, а такое
-- Postgres заменой не пропускает.
drop function if exists public.my_appointments(text);
create function public.my_appointments(p_subject text)
returns table(id uuid, tenant_id uuid, cabinet text, starts_at timestamptz,
              status text, service text, price numeric, is_past boolean,
              confirmed boolean)
language sql stable security definer set search_path to 'public','extensions' as $$
  select a.id, a.tenant_id, t.name, a.starts_at, a.status,
         s.name_ru, s.price, a.starts_at < now(), a.confirmed_at is not null
    from appointments a
    join patients p on p.id = a.patient_id
    join tenants  t on t.id = a.tenant_id
    left join services s on s.id = a.service_id
   where p.telegram_subject = p_subject
   order by a.starts_at desc;
$$;


revoke all on function public.slot_is_offered(uuid,uuid,uuid,timestamptz)
  from public, anon, authenticated;
revoke all on function public.confirm_appointment(text,uuid)
  from public, anon, authenticated;
revoke all on function public.reschedule_appointment(uuid,uuid,timestamptz)
  from public, anon, authenticated;

-- Сторож из 033: confirm_appointment тенанта не принимает ОСОЗНАННО — её ключ
-- подписанный subject, ровно как у my_appointments.
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
       'confirm_appointment',
       'set_verified_phone', 'normalize_phone',
       'provision_tenant', 'provision_tenant_core', 'available_templates',
       'template_health', 'subscription_plans_list', 'due_subscription_notices',
       'rls_health', 'prune_access_log'
     )
     and has_function_privilege('service_role', p.oid, 'execute')
   order by p.proname;
$$;
