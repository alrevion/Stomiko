-- 078_person_profile_and_geo

-- Профиль человека: ФИО, номер и место.
--
-- Имя из Telegram — это ник, а не ФИО: «Yakov», «ᅠ», пустая строка. Врачу в
-- карточке нужно имя, по которому он позовёт пациента в кресло, и пациент
-- вводил его ЗАНОВО при каждой записи в каждый кабинет. Спрашиваем один раз.
--
-- Место нужно ради главного вопроса пациента с рекламы: «кто ко мне ближе».
-- Без координат кабинета оно бессмысленно, поэтому координаты появляются с
-- обеих сторон: врач отправляет их из кабинета, пациент — от себя.

alter table app_users add column if not exists full_name text;
alter table app_users add column if not exists lat double precision;
alter table app_users add column if not exists lon double precision;
alter table app_users add column if not exists located_at timestamptz;

alter table tenants add column if not exists lat double precision;
alter table tenants add column if not exists lon double precision;

comment on column app_users.full_name is
  'ФИО, которое человек назвал сам. Имя из Telegram — ник и для карточки не годится.';
comment on column tenants.lat is 'Широта кабинета: врач отправляет её, стоя в кабинете.';

/**
 * Сохранить профиль.
 *
 * Пустое поле означает «не трогать», а не «стереть»: экран профиля может
 * прислать только имя, только координаты или всё сразу, и каждый такой вызов
 * не должен обнулять остальное.
 */
create or replace function public.set_person_profile(
  p_subject text, p_full_name text default null,
  p_lat double precision default null, p_lon double precision default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public','extensions' as $$
declare v_name text;
begin
  v_name := nullif(trim(coalesce(p_full_name, '')), '');
  if v_name is not null and length(v_name) < 2 then
    raise exception 'имя из одной буквы врачу ничего не скажет' using errcode='P0001';
  end if;
  if (p_lat is null) <> (p_lon is null) then
    raise exception 'координата без пары' using errcode='P0001';
  end if;
  if p_lat is not null and (abs(p_lat) > 90 or abs(p_lon) > 180) then
    raise exception 'такой точки на земле нет' using errcode='P0001';
  end if;

  update app_users
     set full_name  = coalesce(v_name, full_name),
         lat        = coalesce(p_lat, lat),
         lon        = coalesce(p_lon, lon),
         located_at = case when p_lat is not null then now() else located_at end
   where subject = p_subject;
  if not found then raise exception 'человек не найден' using errcode='P0002'; end if;

  return (select jsonb_build_object(
            'fullName', u.full_name, 'lat', u.lat, 'lon', u.lon,
            'locatedAt', u.located_at)
            from app_users u where u.subject = p_subject);
end $$;

/** Контекст входа. Тело прежнее; добавлены ФИО и место. */
create or replace function public.user_context(p_subject text)
returns jsonb
language sql stable security definer set search_path to 'public','extensions' as $$
  select jsonb_build_object(
    'subject', u.subject,
    'firstName', u.first_name,
    'fullName', u.full_name,
    'lat', u.lat,
    'lon', u.lon,
    'phone', u.phone,
    'phoneVerified', u.phone_verified_at is not null,
    'activeMode', u.active_mode,
    'activeTenantId', u.active_tenant_id,
    'modeChosen', u.mode_chosen_at is not null,
    'activeCabinet', (
      select jsonb_build_object('tenantId', t.id, 'name', t.name, 'token', t.public_token)
        from tenants t
       where t.id = u.active_tenant_id
         and (t.listed
              or exists (select 1 from memberships m
                          where m.tenant_id = t.id and m.subject = u.subject)
              or exists (select 1 from patients p
                          where p.tenant_id = t.id and p.telegram_subject = u.subject))),
    'staffOf', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tenantId', t.id, 'name', t.name, 'role', m.role, 'token', t.public_token,
               'onboarding', t.onboarding,
               'catalogReviewed', t.catalog_reviewed_at is not null)
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
$$;

/** Карточка кабинета для поиска. Тело прежнее; добавлены координаты. */
create or replace function public.cabinet_listing(p_tenant_id uuid)
returns jsonb
language sql stable security definer set search_path to 'public','extensions' as $$
  select jsonb_build_object(
    'name', t.name, 'city', coalesce(t.city, ''), 'address', coalesce(t.address, ''),
    'landmark', coalesce(t.landmark, ''), 'phone', coalesce(t.contact_phone, ''),
    'lat', t.lat, 'lon', t.lon, 'listed', t.listed)
    from tenants t where t.id = p_tenant_id;
$$;

/**
 * Настройка показа в поиске. Тело из 058b; добавлены координаты.
 *
 * Координаты необязательны: кабинет без них найдётся по городу и адресу,
 * просто не встанет в список «ближайших». Требовать их для публикации —
 * значит закрыть поиск тем, у кого в подвале нет сигнала.
 */
drop function if exists public.set_cabinet_listing(uuid,text,text,text,text,boolean);

create or replace function public.set_cabinet_listing(
  p_tenant_id uuid, p_city text, p_address text, p_landmark text,
  p_phone text, p_listed boolean,
  p_lat double precision default null, p_lon double precision default null
) returns jsonb
language plpgsql volatile security definer set search_path to 'public','extensions' as $$
declare v_city text; v_addr text; v_land text; v_phone text;
begin
  v_city  := nullif(trim(coalesce(p_city, '')), '');
  v_addr  := nullif(trim(coalesce(p_address, '')), '');
  v_land  := nullif(trim(coalesce(p_landmark, '')), '');
  v_phone := nullif(trim(coalesce(p_phone, '')), '');

  if p_listed and (v_city is null or v_addr is null or v_phone is null) then
    raise exception 'чтобы кабинет появился в поиске, укажите город, адрес и телефон'
      using errcode='P0001';
  end if;
  if (p_lat is null) <> (p_lon is null) then
    raise exception 'координата без пары' using errcode='P0001';
  end if;

  update tenants
     set city = v_city, address = v_addr, landmark = v_land,
         contact_phone = v_phone, listed = p_listed,
         lat = coalesce(p_lat, lat), lon = coalesce(p_lon, lon)
   where id = p_tenant_id;
  if not found then raise exception 'кабинет не найден' using errcode='P0002'; end if;

  return (select jsonb_build_object('listed', t.listed, 'city', t.city, 'address', t.address,
                                    'landmark', t.landmark, 'phone', t.contact_phone,
                                    'lat', t.lat, 'lon', t.lon)
            from tenants t where t.id = p_tenant_id);
end $$;

/**
 * Витрина кабинетов. Тело из 058c; добавлено расстояние.
 *
 * Расстояние по прямой, а не по дорогам: маршрут — это чужая карта и чужой
 * ключ, а «два километра» и «двадцать» человек различает и так. Когда место
 * неизвестно, порядок прежний — по ближайшему свободному времени.
 */
drop function if exists public.public_cabinets(text,text);

create or replace function public.public_cabinets(
  p_city text default null, p_query text default null,
  p_lat double precision default null, p_lon double precision default null
) returns table (
  tenant_id uuid, name text, doctor text, city text, address text,
  landmark text, phone text, consult_price numeric, next_slot timestamptz,
  distance_km numeric
)
language sql stable security definer set search_path to 'public','extensions' as $$
  select x.tenant_id, x.name, x.doctor, x.city, x.address, x.landmark,
         x.phone, x.consult_price, x.next_slot, x.distance_km
    from (
      select t.id as tenant_id, t.name,
             (select r.name from resources r
               where r.tenant_id = t.id and r.kind = 'practitioner'
                 and r.name not in ('Врач', 'Доктор', '') limit 1) as doctor,
             t.city, t.address, t.landmark, t.contact_phone as phone,
             s.price as consult_price,
             (select min(sl.slot_start)
                from available_slots(
                       t.id,
                       (select r.id from resources r
                         where r.tenant_id = t.id and r.kind = 'chair' limit 1),
                       s.id,
                       (now() at time zone t.timezone)::date,
                       ((now() + interval '14 days') at time zone t.timezone)::date) sl
             ) as next_slot,
             case when p_lat is null or t.lat is null then null
                  else round((6371 * 2 * asin(sqrt(
                         power(sin(radians(t.lat - p_lat) / 2), 2)
                         + cos(radians(p_lat)) * cos(radians(t.lat))
                           * power(sin(radians(t.lon - p_lon) / 2), 2)
                       )))::numeric, 1)
             end as distance_km
        from tenants t
        join subscriptions sub on sub.tenant_id = t.id and sub.paid_until >= now()
        left join lateral (
          select sv.id, sv.price from services sv
           where sv.tenant_id = t.id and sv.bookable
           order by (sv.code like 'B01.%') desc, sv.price
           limit 1) s on true
       where t.listed
         and (nullif(trim(coalesce(p_city, '')), '') is null
              or lower(t.city) = lower(trim(p_city)))
         and (nullif(trim(coalesce(p_query, '')), '') is null
              or t.name ilike '%' || trim(p_query) || '%'
              or coalesce(t.address, '') ilike '%' || trim(p_query) || '%'
              or coalesce(t.landmark, '') ilike '%' || trim(p_query) || '%')
    ) x
   order by x.distance_km nulls last, x.next_slot nulls last, x.name;
$$;

revoke all on function public.set_person_profile(text,text,double precision,double precision)
  from public, anon, authenticated;
revoke all on function public.set_cabinet_listing(uuid,text,text,text,text,boolean,double precision,double precision)
  from public, anon, authenticated;
revoke all on function public.public_cabinets(text,text,double precision,double precision)
  from public, anon, authenticated;

-- Сторож должен знать про профиль: он ключуется подписанным subject, тенант
-- ему не нужен и не должен быть нужен — профиль принадлежит человеку.
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
       'confirm_appointment', 'my_treatment_plans', 'set_person_profile',
       'material_unit_price', 'tg_close_plan_items', 'tg_seal_clinical_entries',
       'public_cabinets', 'public_cities',
       'person_cards', 'person_summary', 'my_clinical_record',
       'backfill_clinical_history', 'clinical_health', 'clinical_log_health',
       'mark_palette', 'tooth_chart_of', 'my_tooth_chart',
       'set_verified_phone', 'normalize_phone',
       'provision_tenant', 'provision_tenant_core', 'available_templates',
       'template_health', 'subscription_plans_list', 'due_subscription_notices',
       'rls_health', 'prune_access_log'
     )
     and has_function_privilege('service_role', p.oid, 'execute')
   order by p.proname;
$$;
