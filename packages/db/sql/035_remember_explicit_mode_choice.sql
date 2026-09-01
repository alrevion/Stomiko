-- 035_remember_explicit_mode_choice (применена 20260901110256)

-- 035: отличить выбранный режим от режима по умолчанию.
--
-- Врач переключался в пациента, а приложение возвращало его в кабинет:
-- у него нет карточки пациента ни в одном кабинете, и запасной путь
-- «работает в кабинете — показываем кабинет» перебивал явный выбор.
--
-- Выбор человека и догадка системы — разные вещи, и различать их должна
-- отметка, а не совпадение значений.
alter table app_users add column if not exists mode_chosen_at timestamptz;

create or replace function public.set_user_mode(
  p_subject text, p_mode text, p_tenant_id uuid default null)
returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare tid uuid;
begin
  if p_mode not in ('patient','doctor') then
    raise exception 'неизвестный режим' using errcode='P0001';
  end if;

  if p_mode = 'doctor' then
    select m.tenant_id into tid from memberships m
     where m.subject = p_subject
       and (p_tenant_id is null or m.tenant_id = p_tenant_id)
     order by (m.tenant_id = p_tenant_id) desc
     limit 1;
    if tid is null then
      raise exception 'у вас нет доступа к этому кабинету' using errcode='P0001';
    end if;
  else
    tid := p_tenant_id;
  end if;

  update app_users
     set active_mode = p_mode, active_tenant_id = tid, mode_chosen_at = now()
   where subject = p_subject;
  return jsonb_build_object('mode', p_mode, 'tenantId', tid);
end $$;

create or replace function public.user_context(p_subject text)
returns jsonb
language sql stable security definer set search_path to 'public','extensions' as $$
  select jsonb_build_object(
    'subject', u.subject,
    'firstName', u.first_name,
    'phone', u.phone,
    'phoneVerified', u.phone_verified_at is not null,
    'activeMode', u.active_mode,
    'activeTenantId', u.active_tenant_id,
    'modeChosen', u.mode_chosen_at is not null,
    'staffOf', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tenantId', t.id, 'name', t.name, 'role', m.role, 'token', t.public_token)
               order by t.name)
        from memberships m join tenants t on t.id = m.tenant_id
       where m.subject = u.subject), '[]'::jsonb),
    'patientOf', coalesce((
      select jsonb_agg(x order by x->>'name') from (
        select distinct on (t.id) jsonb_build_object(
                 'tenantId', t.id, 'name', t.name, 'token', t.public_token,
                 'lastVisit', (select max(v.visit_date) from visits v where v.patient_id = p.id),
                 'upcoming', (select count(*) from appointments a
                               where a.patient_id = p.id and a.status = 'scheduled'
                                 and a.starts_at >= now())) as x
          from patients p join tenants t on t.id = p.tenant_id
         where p.telegram_subject = u.subject
      ) q), '[]'::jsonb)
  )
  from app_users u where u.subject = p_subject;
$$;;
