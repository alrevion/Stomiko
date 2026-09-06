-- 079_license_gates_the_search

-- Лицензия открывает поиск, а не кабинет.
--
-- Разделение простое и важное. Кабинет без публикации — личный инструмент:
-- врач ведёт в нём тех, кто и так к нему ходит, чужих карт не видит, в
-- поиске не появляется. Вреда никому, и требовать документы у человека,
-- который просто хочет вести свою запись, значит потерять его на первом
-- экране. Так работает большинство частных кабинетов — по своей ссылке.
--
-- А вот когда карточка встаёт в общий список, платформа фактически говорит
-- пациенту «вот вам стоматолог». За это она отвечает. Значит, документы
-- проверяются ровно здесь — на входе в поиск.
--
-- Проверка сегодня ручная: реестр Минюста закрыт для программных обращений
-- (Turnstile), и обходить это нельзя — сломается молча. Врач называет номер
-- лицензии, владелец платформы открывает реестр по ссылке и решает. Когда
-- будет официальный доступ, тело `review_cabinet_license` заменится на
-- вызов реестра, а экраны останутся те же.

alter table tenants add column if not exists license_number text;
alter table tenants add column if not exists license_tin text;
alter table tenants add column if not exists license_status text not null default 'none';
alter table tenants add column if not exists license_valid_until date;
alter table tenants add column if not exists license_note text;
alter table tenants add column if not exists license_submitted_at timestamptz;
alter table tenants add column if not exists license_checked_at timestamptz;
alter table tenants add column if not exists license_checked_by text;

do $$ begin
  alter table tenants add constraint license_status_known
    check (license_status in ('none', 'pending', 'verified', 'rejected'));
exception when duplicate_object then null; end $$;

comment on column tenants.license_number is
  'Номер лицензии на медицинскую деятельность. Проверяется в реестре Минюста.';
comment on column tenants.license_status is
  'none — не подавал, pending — ждёт проверки, verified — проверена, rejected — отказ.';

-- Кабинеты, ждущие проверки, ищутся по одному полю.
create index if not exists tenants_license_pending
  on tenants (license_submitted_at) where license_status = 'pending';

/**
 * Врач называет номер лицензии.
 *
 * Повторная подача сбрасывает прежний вердикт: если человек прислал другой
 * номер, старое «проверено» к нему больше не относится. Кабинет при этом
 * уходит из поиска — иначе отметка «документы проверены» пережила бы сам
 * документ.
 */
create or replace function public.set_cabinet_license(
  p_tenant_id uuid, p_number text, p_tin text default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public','extensions' as $$
declare v_num text; v_tin text;
begin
  v_num := nullif(regexp_replace(coalesce(p_number, ''), '\s', '', 'g'), '');
  v_tin := nullif(regexp_replace(coalesce(p_tin, ''), '\s', '', 'g'), '');
  if v_num is null or length(v_num) < 4 then
    raise exception 'номер лицензии слишком короткий, чтобы его найти в реестре'
      using errcode='P0001';
  end if;
  if v_num !~ '^[0-9A-Za-z№/\-]+$' then
    raise exception 'в номере лицензии есть лишние знаки' using errcode='P0001';
  end if;

  update tenants
     set license_number = v_num,
         license_tin = coalesce(v_tin, license_tin),
         license_status = 'pending',
         license_note = null,
         license_valid_until = null,
         license_submitted_at = now(),
         license_checked_at = null,
         license_checked_by = null,
         -- Пока номер не проверен, кабинета в поиске нет.
         listed = false
   where id = p_tenant_id;
  if not found then raise exception 'кабинет не найден' using errcode='P0002'; end if;

  return (select jsonb_build_object('licenseNumber', t.license_number,
            'licenseTin', t.license_tin, 'licenseStatus', t.license_status)
            from tenants t where t.id = p_tenant_id);
end $$;

/**
 * Вердикт по лицензии.
 *
 * Отказ обязан нести причину: «отклонено» без слов врач прочитает как
 * произвол платформы и уйдёт, не поняв, что исправлять.
 */
create or replace function public.review_cabinet_license(
  p_tenant_id uuid, p_verdict text, p_actor text,
  p_valid_until date default null, p_note text default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public','extensions' as $$
declare v_note text;
begin
  if p_verdict not in ('verified', 'rejected') then
    raise exception 'вердикт бывает только «проверено» или «отказ»' using errcode='P0001';
  end if;
  v_note := nullif(trim(coalesce(p_note, '')), '');
  if p_verdict = 'rejected' and v_note is null then
    raise exception 'отказ без причины врачу ничего не говорит' using errcode='P0001';
  end if;

  update tenants
     set license_status = p_verdict,
         license_valid_until = case when p_verdict = 'verified' then p_valid_until end,
         license_note = v_note,
         license_checked_at = now(),
         license_checked_by = p_actor
   where id = p_tenant_id and license_status = 'pending';
  if not found then
    raise exception 'этот кабинет не ждёт проверки' using errcode='P0002';
  end if;

  return (select jsonb_build_object('tenantId', t.id, 'name', t.name,
            'licenseStatus', t.license_status, 'validUntil', t.license_valid_until)
            from tenants t where t.id = p_tenant_id);
end $$;

/** Очередь проверки: кто ждёт и с каким номером. */
create or replace function public.pending_licenses()
returns table (
  tenant_id uuid, name text, doctor text, city text, address text,
  phone text, license_number text, license_tin text, submitted_at timestamptz
)
language sql stable security definer set search_path to 'public','extensions' as $$
  select t.id, t.name,
         (select r.name from resources r
           where r.tenant_id = t.id and r.kind = 'practitioner'
             and r.name not in ('Врач', 'Доктор', '') limit 1),
         t.city, t.address, t.contact_phone,
         t.license_number, t.license_tin, t.license_submitted_at
    from tenants t
   where t.license_status = 'pending'
   order by t.license_submitted_at;
$$;

/**
 * Карточка кабинета для поиска. Тело из 078; добавлены поля лицензии.
 */
create or replace function public.cabinet_listing(p_tenant_id uuid)
returns jsonb
language sql stable security definer set search_path to 'public','extensions' as $$
  select jsonb_build_object(
    'name', t.name, 'city', coalesce(t.city, ''), 'address', coalesce(t.address, ''),
    'landmark', coalesce(t.landmark, ''), 'phone', coalesce(t.contact_phone, ''),
    'lat', t.lat, 'lon', t.lon, 'listed', t.listed,
    'licenseNumber', coalesce(t.license_number, ''),
    'licenseTin', coalesce(t.license_tin, ''),
    'licenseStatus', t.license_status,
    'licenseNote', coalesce(t.license_note, ''),
    'licenseValidUntil', t.license_valid_until)
    from tenants t where t.id = p_tenant_id;
$$;

/**
 * Настройка показа в поиске. Тело из 078; добавлена проверка лицензии.
 *
 * Публикация без проверенной лицензии теперь невозможна — в этом весь смысл
 * разделения. Убрать себя из поиска можно всегда и без условий.
 */
create or replace function public.set_cabinet_listing(
  p_tenant_id uuid, p_city text, p_address text, p_landmark text,
  p_phone text, p_listed boolean,
  p_lat double precision default null, p_lon double precision default null
) returns jsonb
language plpgsql volatile security definer set search_path to 'public','extensions' as $$
declare v_city text; v_addr text; v_land text; v_phone text; v_lic text;
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

  if p_listed then
    select t.license_status into v_lic from tenants t where t.id = p_tenant_id;
    if v_lic is distinct from 'verified' then
      raise exception 'в поиск пускаем только с проверенной лицензией'
        using errcode='P0001';
    end if;
  end if;

  update tenants
     set city = v_city, address = v_addr, landmark = v_land,
         contact_phone = v_phone, listed = p_listed,
         lat = coalesce(p_lat, lat), lon = coalesce(p_lon, lon)
   where id = p_tenant_id;
  if not found then raise exception 'кабинет не найден' using errcode='P0002'; end if;

  return (select jsonb_build_object('listed', t.listed, 'city', t.city, 'address', t.address,
                                    'landmark', t.landmark, 'phone', t.contact_phone,
                                    'lat', t.lat, 'lon', t.lon,
                                    'licenseStatus', t.license_status)
            from tenants t where t.id = p_tenant_id);
end $$;

revoke all on function public.set_cabinet_license(uuid,text,text) from public, anon, authenticated;
revoke all on function public.review_cabinet_license(uuid,text,text,date,text) from public, anon, authenticated;
revoke all on function public.pending_licenses() from public, anon, authenticated;

-- Сторож: проверка лицензий кабинету не принадлежит. `review_cabinet_license`
-- и `pending_licenses` — работа владельца ПЛАТФОРМЫ, а не кабинета, и права
-- на них отсекает воркер по списку, а не тенант.
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
       'public_cabinets', 'public_cities', 'pending_licenses',
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
