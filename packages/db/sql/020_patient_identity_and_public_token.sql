-- 020_patient_identity_and_public_token (применена 20260825102734)

-- Публичная ссылка врача. В URL уходит НЕПРОЗРАЧНЫЙ токен, а не id кабинета:
-- иначе любой желающий перебирает ?startapp=1..99999 и выкачивает базу врачей.
-- Ограничение Telegram: startapp — до 64 символов base64url (A-Z a-z 0-9 - _).
alter table tenants add column public_token text unique;
update tenants set public_token = 'd_' || replace(encode(gen_random_bytes(6),'base64'),'/','_')
  where public_token is null;
alter table tenants alter column public_token set not null;

-- Пациент, пришедший из Telegram, привязывается к своему аккаунту: чтобы
-- «мои записи» работали и чтобы повторная запись не заводила вторую карточку.
alter table patients add column telegram_subject text;
create unique index patients_tg_uq on patients (tenant_id, telegram_subject)
  where telegram_subject is not null;

-- Отмена записи пациентом: строки занятости удаляются, слот освобождается.
create or replace function cancel_appointment(p_appointment_id uuid, p_by text)
returns void
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare a appointments%rowtype;
begin
  select * into a from appointments where id = p_appointment_id for update;
  if not found then raise exception 'запись не найдена' using errcode='P0002'; end if;
  if a.status = 'cancelled' then return; end if;
  if exists (select 1 from visits v where v.appointment_id = a.id and v.status = 'closed') then
    raise exception 'приём уже закрыт, запись отменить нельзя' using errcode='P0001';
  end if;

  update appointments set status = 'cancelled',
         note = coalesce(note,'') || ' [отменено: ' || p_by || ']'
   where id = p_appointment_id;
  -- Слот обязан освободиться сразу: частичного предиката в EXCLUDE нет,
  -- занятость выражена наличием строк.
  delete from appointment_resources where appointment_id = p_appointment_id;
end $$;

-- Блокировка промежутка врачом («занят», «обед», «уехал»). Это не запись
-- пациента, но занимает ресурс так же — иначе в слоты пролезет чужое время.
create or replace function block_time(
  p_tenant_id uuid, p_resource_id uuid,
  p_starts_at timestamptz, p_ends_at timestamptz, p_reason text
) returns uuid
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare pid uuid; aid uuid;
begin
  if p_ends_at <= p_starts_at then raise exception 'конец раньше начала' using errcode='P0001'; end if;

  select id into pid from patients where tenant_id = p_tenant_id and full_name = '— занято —';
  if pid is null then
    insert into patients (tenant_id, full_name) values (p_tenant_id, '— занято —') returning id into pid;
  end if;

  insert into appointments (tenant_id, patient_id, starts_at, ends_at, source, note)
    values (p_tenant_id, pid, p_starts_at, p_ends_at, 'staff', coalesce(p_reason,'занято'))
    returning id into aid;
  insert into appointment_resources (tenant_id, appointment_id, resource_id, role, starts_at, ends_at)
    values (p_tenant_id, aid, p_resource_id, 'chair', p_starts_at, p_ends_at);
  return aid;
exception when exclusion_violation then
  raise exception 'на это время уже есть запись' using errcode='23P01';
end $$;

revoke all on function cancel_appointment(uuid,text) from public, anon, authenticated;
revoke all on function block_time(uuid,uuid,timestamptz,timestamptz,text) from public, anon, authenticated;

select public_token from tenants;;
