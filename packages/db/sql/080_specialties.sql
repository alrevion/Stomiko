-- 080_specialties

-- Специализации кабинета: список, а не одна строка.
--
-- До сих пор специализация была побочным свойством стартового справочника:
-- выбрал «Стоматолог-терапевт» — им и записался. Но кабинет чаще всего не
-- один в одном лице: тот же врач лечит каналы и ставит коронки, а в двух
-- креслах работают терапевт и ортопед. Пациенту в поиске важно как раз это.
--
-- Справочник и специализация теперь разные вещи. Справочник — стартовые
-- материалы, техкарты и нормы расхода, он один и подставляется при
-- регистрации. Специализации — то, чем кабинет занимается; их несколько, и
-- они правятся когда угодно.

create table if not exists specialties (
  code text primary key,
  name_ru text not null,
  position int not null default 100
);

insert into specialties (code, name_ru, position) values
  ('therapist',     'Стоматолог-терапевт',  10),
  ('surgeon',       'Стоматолог-хирург',    20),
  ('orthopedist',   'Стоматолог-ортопед',   30),
  ('orthodontist',  'Ортодонт',             40),
  ('pediatric',     'Детский стоматолог',   50),
  ('periodontist',  'Пародонтолог',         60),
  ('endodontist',   'Эндодонтист',          70),
  ('implantologist','Имплантолог',          80),
  ('hygienist',     'Гигиенист',            90)
on conflict (code) do update set name_ru = excluded.name_ru, position = excluded.position;

alter table tenants add column if not exists specialties text[] not null default '{}';

comment on column tenants.specialties is
  'Чем кабинет занимается. Список, а не одна строка: врач редко только терапевт.';

-- Кабинеты, созданные до этой правки, знают свою специализацию из
-- справочника, с которого начинали.
update tenants t
   set specialties = array[c.specialty]
  from catalog_templates c
 where t.specialties = '{}'
   and c.specialty is not null
   and exists (select 1 from services s where s.tenant_id = t.id);

/** Справочник специализаций для экранов выбора. */
create or replace function public.specialty_list()
returns table (code text, name_ru text)
language sql stable security definer set search_path to 'public','extensions' as $$
  select s.code, s.name_ru from specialties s order by s.position, s.name_ru;
$$;

/**
 * Специализации кабинета.
 *
 * Пустой список запрещён: карточка без единой специализации не отвечает на
 * первый вопрос пациента — «а вы вообще что делаете». Неизвестные коды
 * отсекаются здесь, а не тихо сохраняются: иначе поиск однажды начнёт
 * фильтровать по строке, которой нет в справочнике.
 */
create or replace function public.set_cabinet_specialties(
  p_tenant_id uuid, p_codes text[])
returns jsonb
language plpgsql volatile security definer set search_path to 'public','extensions' as $$
declare v_codes text[];
begin
  select array_agg(distinct c order by c) into v_codes
    from unnest(coalesce(p_codes, '{}')) as c
   where c in (select code from specialties);

  if v_codes is null or array_length(v_codes, 1) is null then
    raise exception 'выберите хотя бы одну специализацию' using errcode='P0001';
  end if;

  update tenants set specialties = v_codes where id = p_tenant_id;
  if not found then raise exception 'кабинет не найден' using errcode='P0002'; end if;
  return jsonb_build_object('specialties', v_codes);
end $$;

/** Карточка кабинета. Тело из 079; добавлены специализации. */
create or replace function public.cabinet_listing(p_tenant_id uuid)
returns jsonb
language sql stable security definer set search_path to 'public','extensions' as $$
  select jsonb_build_object(
    'name', t.name, 'city', coalesce(t.city, ''), 'address', coalesce(t.address, ''),
    'landmark', coalesce(t.landmark, ''), 'phone', coalesce(t.contact_phone, ''),
    'lat', t.lat, 'lon', t.lon, 'listed', t.listed,
    'specialties', to_jsonb(t.specialties),
    'doctor', coalesce((select r.name from resources r
                         where r.tenant_id = t.id and r.kind = 'practitioner'
                           and r.name not in ('Врач', 'Доктор', '') limit 1), ''),
    'licenseNumber', coalesce(t.license_number, ''),
    'licenseTin', coalesce(t.license_tin, ''),
    'licenseStatus', t.license_status,
    'licenseNote', coalesce(t.license_note, ''),
    'licenseValidUntil', t.license_valid_until)
    from tenants t where t.id = p_tenant_id;
$$;

/**
 * Имя врача, которое видят пациенты.
 *
 * Живёт у ресурса-практика, а не у кабинета: в кабинете может работать
 * несколько человек, и подпись в поиске принадлежит тому, кто принимает.
 */
create or replace function public.set_practitioner_name(
  p_tenant_id uuid, p_name text)
returns jsonb
language plpgsql volatile security definer set search_path to 'public','extensions' as $$
declare v_name text; v_id uuid;
begin
  v_name := nullif(trim(coalesce(p_name, '')), '');
  if v_name is null or length(v_name) < 2 then
    raise exception 'имя из одной буквы пациенту ничего не скажет' using errcode='P0001';
  end if;
  select r.id into v_id from resources r
   where r.tenant_id = p_tenant_id and r.kind = 'practitioner'
   order by r.created_at limit 1;
  if v_id is null then
    raise exception 'в кабинете нет ни одного врача' using errcode='P0002';
  end if;
  update resources set name = v_name where id = v_id;
  return jsonb_build_object('doctor', v_name);
end $$;

/** Витрина кабинетов. Тело из 078; добавлены специализации. */
drop function if exists public.public_cabinets(text,text,double precision,double precision);

create or replace function public.public_cabinets(
  p_city text default null, p_query text default null,
  p_lat double precision default null, p_lon double precision default null
) returns table (
  tenant_id uuid, name text, doctor text, city text, address text,
  landmark text, phone text, consult_price numeric, next_slot timestamptz,
  distance_km numeric, specialties text[]
)
language sql stable security definer set search_path to 'public','extensions' as $$
  select x.tenant_id, x.name, x.doctor, x.city, x.address, x.landmark,
         x.phone, x.consult_price, x.next_slot, x.distance_km, x.specialties
    from (
      select t.id as tenant_id, t.name,
             (select r.name from resources r
               where r.tenant_id = t.id and r.kind = 'practitioner'
                 and r.name not in ('Врач', 'Доктор', '') limit 1) as doctor,
             t.city, t.address, t.landmark, t.contact_phone as phone,
             t.specialties,
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
              or coalesce(t.landmark, '') ilike '%' || trim(p_query) || '%'
              or exists (select 1 from specialties sp
                          where sp.code = any(t.specialties)
                            and sp.name_ru ilike '%' || trim(p_query) || '%'))
    ) x
   order by x.distance_km nulls last, x.next_slot nulls last, x.name;
$$;

alter table specialties enable row level security;
revoke all on function public.set_cabinet_specialties(uuid,text[]) from public, anon, authenticated;
revoke all on function public.set_practitioner_name(uuid,text) from public, anon, authenticated;
revoke all on function public.specialty_list() from public, anon, authenticated;
revoke all on function public.public_cabinets(text,text,double precision,double precision) from public, anon, authenticated;

-- Сторож: справочник специализаций кабинету не принадлежит — он общий.
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
       'public_cabinets', 'public_cities', 'pending_licenses', 'specialty_list',
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
