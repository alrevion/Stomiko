-- 034_app_users_and_modes (применена 20260901105805)

-- 034: личность отдельно от роли.
--
-- Было: роль ВЫВОДИЛАСЬ из данных — есть членство, значит навсегда врач.
-- Из-за этого стоматолог не мог записаться к коллеге: приложение считало его
-- врачом и показывало его собственный кабинет.
--
-- Стало: роль — ВЫБРАННЫЙ режим, а данные лишь говорят, какие режимы человеку
-- доступны. Пациентом может быть каждый; врачом — тот, у кого есть членство.
-- Переключатель видит только он; чистый пациент о врачебной стороне не знает.

create table if not exists app_users (
  subject           text primary key,          -- tg:123456, подтверждён подписью initData
  first_name        text,
  phone             text,                      -- заполнится на шаге 4 (requestContact)
  phone_verified_at timestamptz,
  active_mode       text not null default 'patient'
                    check (active_mode in ('patient','doctor')),
  active_tenant_id  uuid references tenants(id) on delete set null,
  created_at        timestamptz not null default now(),
  last_seen_at      timestamptz not null default now()
);

-- Таблица НЕ тенантная: это реестр людей, а не данные кабинета. Один человек,
-- лечащийся в трёх кабинетах, — это три карточки пациента и одна строка здесь.
alter table app_users enable row level security;
alter table app_users force row level security;
create policy app_users_deny_direct on app_users
  as restrictive for all to anon, authenticated using (false);

create index if not exists app_users_phone_idx on app_users (phone) where phone is not null;

-- Отметка визита. Возвращает строку, чтобы не ходить за ней вторым запросом.
create or replace function public.touch_app_user(p_subject text, p_first_name text default null)
returns app_users
language plpgsql security definer set search_path to 'public','extensions' as $$
declare u app_users;
begin
  insert into app_users (subject, first_name)
       values (p_subject, nullif(trim(p_first_name), ''))
  on conflict (subject) do update
     set last_seen_at = now(),
         first_name = coalesce(nullif(trim(p_first_name), ''), app_users.first_name)
  returning * into u;
  return u;
end $$;

/**
 * Всё, что нужно знать про вошедшего.
 *
 * Ключ — subject из подписанного initData, а не идентификатор чужой строки,
 * поэтому тенант тут не при чём: человек получает СВОИ кабинеты и ничьи больше.
 */
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
    -- Кабинеты, где человек работает.
    'staffOf', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tenantId', t.id, 'name', t.name, 'role', m.role, 'token', t.public_token)
               order by t.name)
        from memberships m join tenants t on t.id = m.tenant_id
       where m.subject = u.subject), '[]'::jsonb),
    -- Кабинеты, где человек лечится. Карточка привязана к аккаунту Telegram.
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
$$;

/**
 * Смена режима.
 *
 * Врачом стать нельзя простым выбором: право даёт членство, а не желание.
 * Пациентом — можно всегда, это состояние по умолчанию для каждого.
 */
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

  update app_users set active_mode = p_mode, active_tenant_id = tid
   where subject = p_subject;
  return jsonb_build_object('mode', p_mode, 'tenantId', tid);
end $$;

/** Записи пациента по ВСЕМ кабинетам, где он лечится. */
create or replace function public.my_appointments(p_subject text)
returns table(id uuid, tenant_id uuid, cabinet text, starts_at timestamptz,
              status text, service text, price numeric, is_past boolean)
language sql stable security definer set search_path to 'public','extensions' as $$
  select a.id, a.tenant_id, t.name, a.starts_at, a.status,
         s.name_ru, s.price, a.starts_at < now()
    from appointments a
    join patients p on p.id = a.patient_id
    join tenants  t on t.id = a.tenant_id
    left join services s on s.id = a.service_id
   where p.telegram_subject = p_subject
   order by a.starts_at desc;
$$;

-- Сторож из 033 должен знать, что эти четыре функции тенант не принимают
-- ОСОЗНАННО: их ключ — подписанный subject, а не идентификатор чужой строки.
create or replace function public.audit_tenant_guards()
returns table(имя text, аргументы text, причина text)
language sql stable security definer
set search_path to 'public','extensions','pg_catalog' as $$
  select p.proname::text,
         pg_get_function_arguments(p.oid),
         'достижима снаружи и не проверяет кабинет'
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef
     and p.prokind = 'f'
     and pg_get_function_arguments(p.oid) not like '%p_tenant_id%'
     and p.proname not in (
       'due_reminders',          -- cron по всем кабинетам сразу
       'mark_reminded',          -- cron, id приходит из due_reminders
       'redeem_staff_invite',    -- тенант выводится из приглашения, оно и есть право
       'new_public_token',       -- ничего не читает
       'rotate_public_token',    -- принимает p_tenant_id единственным аргументом
       'audit_tenant_guards',    -- этот сторож
       -- Ключ — subject из подписанного initData. Тенанта у них нет намеренно:
       -- человек получает свои кабинеты и ничьи больше.
       'touch_app_user', 'user_context', 'set_user_mode', 'my_appointments'
     )
     and has_function_privilege('service_role', p.oid, 'execute')
   order by p.proname;
$$;;
