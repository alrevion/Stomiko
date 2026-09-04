-- 065_clinical_entries (применена 20260904133746)

-- 065_clinical_entries
--
-- Шаг 2: клиническая запись принадлежит человеку.
--
-- Она создаётся при ЗАКРЫТИИ приёма и после этого не меняется никем,
-- включая автора. Пока приём открыт, врач правит свой визит как раньше —
-- это его черновик. Закрыл: получился факт, который человек несёт дальше.
-- История, которую можно переписать задним числом, ничего не стоит.
--
-- Кабинет остаётся АВТОРОМ, но не владельцем. Поэтому рядом со ссылкой на
-- кабинет лежат снимки текстом: кабинет может исчезнуть, а строка
-- «12.03, пломба 26 зуба, кабинет такой-то» обязана остаться читаемой.

create table clinical_entries (
  id uuid primary key default gen_random_uuid(),
  -- Владелец. Ключ — подтверждённый аккаунт: историю носит с собой только
  -- тот, кого мы можем опознать.
  person_subject text not null references app_users(subject) on delete cascade,

  -- Автор. Ссылка обнуляется вместе с кабинетом, снимки остаются.
  author_tenant_id uuid references tenants(id) on delete set null,
  author_cabinet   text not null,
  author_doctor    text,

  -- Связь с работой кабинета, пока она существует.
  visit_id         uuid references visits(id) on delete set null,
  visit_service_id uuid references visit_services(id) on delete set null,

  occurred_on  date not null,
  service_name text not null,
  tooth        text check (tooth is null or tooth ~ '^[1-8][1-8]$'),
  quantity     int not null default 1 check (quantity >= 1),
  note         text,

  sealed_at  timestamptz not null default now(),
  -- Исправление — ДОПОЛНЕНИЕ, а не правка: ссылка на запись, которую
  -- уточняет. Исходная остаётся. В медицинской истории «было ошибочно,
  -- теперь правильно» — тоже факт.
  amends     uuid references clinical_entries(id) on delete set null,
  created_at timestamptz not null default now(),

  check (amends is null or visit_service_id is null)
);

create index clinical_person_idx on clinical_entries (person_subject, occurred_on desc);
create index clinical_visit_idx  on clinical_entries (visit_id);
create index clinical_amends_idx on clinical_entries (amends) where amends is not null;

-- Одна оказанная услуга — одна запись. Это и делает запечатывание
-- идемпотентным: повторный вызов и перенос старых данных не задваивают.
create unique index clinical_one_per_service
  on clinical_entries (visit_service_id) where visit_service_id is not null;

-- Таблица по смыслу пересекает кабинеты, как app_users: доступ только
-- функциями, обеим публичным ролям закрыта.
alter table clinical_entries enable row level security;
create policy clinical_entries_deny_anon on clinical_entries
  as restrictive for all to anon using (false);
create policy clinical_entries_deny_auth on clinical_entries
  as restrictive for all to authenticated using (false);

comment on table clinical_entries is
  'Принадлежит человеку, не кабинету. Доступ только через функции.';


/**
 * Запечатывание при закрытии приёма.
 *
 * Отдельным триггером, а не внутри закрытия: закрытие приёма — состояние,
 * и учёт истории должен идти за состоянием, откуда бы его ни поменяли.
 *
 * Зуб берётся из пункта плана, который закрыла эта услуга: в visit_services
 * зуба нет. Это ограничение сегодняшней модели — врач отмечает зуб только
 * в плане. Появится зубная карта — зуб придёт оттуда.
 */
create or replace function public.tg_seal_clinical_entries() returns trigger
language plpgsql security definer set search_path to 'public','extensions' as $$
declare subj text; cab text; doc text;
begin
  select p.telegram_subject into subj from patients p where p.id = new.patient_id;
  -- Нет подтверждённого аккаунта — переносить историю некому.
  if subj is null then return null; end if;

  select t.name into cab from tenants t where t.id = new.tenant_id;
  select r.name into doc from resources r
   where r.tenant_id = new.tenant_id and r.kind = 'practitioner'
     and r.name not in ('Врач','Доктор','') limit 1;

  insert into clinical_entries (
    person_subject, author_tenant_id, author_cabinet, author_doctor,
    visit_id, visit_service_id, occurred_on, service_name, tooth, quantity)
  select subj, new.tenant_id, cab, doc,
         new.id, vs.id, new.visit_date, s.name_ru,
         (select i.tooth from treatment_plan_items i where i.visit_service_id = vs.id),
         vs.quantity
    from visit_services vs
    join services s on s.id = vs.service_id
   where vs.visit_id = new.id
  on conflict (visit_service_id) do nothing;

  return null;
end $$;

drop trigger if exists visits_seal_clinical on visits;
create trigger visits_seal_clinical
  after update of status on visits
  for each row when (new.status = 'closed' and old.status is distinct from 'closed')
  execute function public.tg_seal_clinical_entries();


/**
 * Может ли кабинет видеть историю этого человека.
 *
 * С момента, когда пациент к нему записался, и до закрытия приёма:
 * ответственный врач готовится накануне, а не открывает историю в кресле
 * при пациенте.
 *
 * Запись старше суток от своего времени доступа не даёт: неявка, которую
 * никто не отметил, иначе открывала бы историю навсегда.
 */
create or replace function public.doctor_may_see_person(p_tenant_id uuid, p_subject text)
returns boolean
language sql stable security definer set search_path to 'public','extensions' as $$
  select exists (
    select 1 from appointments a
      join patients p on p.id = a.patient_id
     where a.tenant_id = p_tenant_id and p.telegram_subject = p_subject
       and a.status = 'scheduled' and a.starts_at > now() - interval '1 day')
      or exists (
    select 1 from visits v
      join patients p on p.id = v.patient_id
     where v.tenant_id = p_tenant_id and p.telegram_subject = p_subject
       and v.status = 'open');
$$;


/** Своя история целиком. Ключ — подписанный subject. */
create or replace function public.my_clinical_record(p_subject text)
returns jsonb
language sql stable security definer set search_path to 'public','extensions' as $$
  select coalesce(jsonb_agg(x order by x->>'occurredOn' desc, x->>'sealedAt' desc), '[]'::jsonb)
    from (
      select jsonb_build_object(
        'id', e.id, 'occurredOn', e.occurred_on, 'service', e.service_name,
        'tooth', e.tooth, 'quantity', e.quantity, 'note', e.note,
        'cabinet', e.author_cabinet, 'doctor', e.author_doctor,
        'cabinetGone', e.author_tenant_id is null,
        'sealedAt', e.sealed_at, 'amends', e.amends) as x
        from clinical_entries e
       where e.person_subject = p_subject
    ) q;
$$;

/**
 * История человека для врача.
 *
 * Право проверяется здесь, а не в маршруте: это единственное место, где
 * данные одного кабинета показываются другому, и правило должно читаться
 * в одном месте. Каждое обращение пишется в журнал доступа.
 */
create or replace function public.person_record_for_doctor(
  p_tenant_id uuid, p_subject text, p_actor text
) returns jsonb
language plpgsql stable security definer set search_path to 'public','extensions' as $$
declare r jsonb;
begin
  if not public.doctor_may_see_person(p_tenant_id, p_subject) then
    raise exception 'история открыта только пока пациент записан или приём не закрыт'
      using errcode='P0001';
  end if;
  perform public.log_access(p_tenant_id, p_actor, 'clinical_record', null, p_subject);
  select public.my_clinical_record(p_subject) into r;
  return r;
end $$;

/**
 * Дополнение к запечатанной записи.
 *
 * Правки нет и не будет: исходная запись остаётся, дополнение встаёт рядом.
 * Так следующий врач видит и что записали, и что потом уточнили.
 */
create or replace function public.amend_clinical_entry(
  p_tenant_id uuid, p_entry_id uuid, p_note text, p_actor text
) returns jsonb
language plpgsql volatile security definer set search_path to 'public','extensions' as $$
declare e clinical_entries%rowtype; cab text; doc text; nid uuid;
begin
  select * into e from clinical_entries where id = p_entry_id;
  if not found then raise exception 'запись не найдена' using errcode='P0002'; end if;
  if coalesce(trim(p_note), '') = '' then
    raise exception 'дополнение без текста ничего не уточняет' using errcode='P0001';
  end if;
  if not public.doctor_may_see_person(p_tenant_id, e.person_subject) then
    raise exception 'дополнить историю можно, только пока пациент записан или приём открыт'
      using errcode='P0001';
  end if;

  select t.name into cab from tenants t where t.id = p_tenant_id;
  select r.name into doc from resources r
   where r.tenant_id = p_tenant_id and r.kind = 'practitioner'
     and r.name not in ('Врач','Доктор','') limit 1;

  insert into clinical_entries (
    person_subject, author_tenant_id, author_cabinet, author_doctor,
    occurred_on, service_name, tooth, quantity, note, amends)
  values (e.person_subject, p_tenant_id, cab, doc,
          (now() at time zone 'Asia/Tashkent')::date,
          'Уточнение к записи от ' || to_char(e.occurred_on, 'DD.MM.YYYY'),
          e.tooth, 1, trim(p_note), e.id)
  returning id into nid;

  perform public.log_access(p_tenant_id, p_actor, 'clinical_amend', nid, e.person_subject);
  return jsonb_build_object('entryId', nid, 'amends', e.id);
end $$;

revoke all on function public.doctor_may_see_person(uuid,text) from public, anon, authenticated;
revoke all on function public.my_clinical_record(text) from public, anon, authenticated;
revoke all on function public.person_record_for_doctor(uuid,text,text) from public, anon, authenticated;
revoke all on function public.amend_clinical_entry(uuid,uuid,text,text) from public, anon, authenticated;

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
       'confirm_appointment', 'my_treatment_plans',
       'material_unit_price', 'tg_close_plan_items', 'tg_seal_clinical_entries',
       'public_cabinets', 'public_cities',
       'person_cards', 'person_summary', 'my_clinical_record',
       'set_verified_phone', 'normalize_phone',
       'provision_tenant', 'provision_tenant_core', 'available_templates',
       'template_health', 'subscription_plans_list', 'due_subscription_notices',
       'rls_health', 'prune_access_log'
     )
     and has_function_privilege('service_role', p.oid, 'execute')
   order by p.proname;
$$;;
