-- 051_access_log (применена 20260901121342)

-- 051: журнал доступа к медицинским данным.
--
-- Зачем: при споре «кто смотрел карту» это единственное доказательство.
-- Пока в кабинете один врач, журнал избыточен; как только появляется
-- ассистент — он становится единственным способом ответить на вопрос.
--
-- Пишется ВНУТРИ функций, отдающих данные, а не в маршрутах. Журнал, который
-- заполняет вызывающий код, однажды забудут — и забудут ровно там, где потом
-- будет нужен. Аргумент `p_actor` обязателен: маршрут, который его не
-- передал, падает сразу, а не пишет молча мимо журнала.
--
-- Логируем НЕ всё. Календарь и склад открывают десятки раз в день, и запись
-- о них утопила бы то, ради чего журнал заведён. Здесь только обращения
-- к личным данным: карточка, приём, поиск по базе.

create table access_log (
  id        bigserial primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  subject   text not null,
  action    text not null check (action in
              ('patient_card','patient_search','visit','patient_edit','staff_joined')),
  target_id uuid,
  detail    text,
  at        timestamptz not null default now()
);

create index access_log_tenant_at   on access_log (tenant_id, at desc);
create index access_log_target      on access_log (tenant_id, target_id, at desc)
  where target_id is not null;

alter table access_log enable row level security;
alter table access_log force row level security;
create policy access_log_deny_direct on access_log
  as restrictive for all to anon, authenticated using (false);

/**
 * Запись в журнал.
 *
 * Ошибка записи НЕ должна ронять чтение карточки: врач у кресла важнее
 * полноты журнала. Но и молчать нельзя — пишем в лог сервера.
 */
create or replace function public.log_access(
  p_tenant_id uuid, p_subject text, p_action text,
  p_target_id uuid default null, p_detail text default null)
returns void
language plpgsql security definer set search_path to 'public','extensions' as $$
begin
  insert into access_log (tenant_id, subject, action, target_id, detail)
       values (p_tenant_id, p_subject, p_action, p_target_id, left(p_detail, 200));
exception when others then
  raise warning 'журнал доступа: %', sqlerrm;
end $$;

-- ── Функции, отдающие личные данные, теперь требуют, кто спрашивает ──────

create or replace function public.patient_card(
  p_tenant_id uuid, p_patient_id uuid, p_actor text)
returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare res jsonb;
begin
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
  ) into res
  from patients p
  where p.id = p_patient_id and p.tenant_id = p_tenant_id;

  if res is not null then
    perform log_access(p_tenant_id, p_actor, 'patient_card', p_patient_id);
  end if;
  return res;
end $$;

create or replace function public.visit_detail(
  p_tenant_id uuid, p_visit_id uuid, p_actor text)
returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare res jsonb;
begin
  if not exists (select 1 from visits where id = p_visit_id and tenant_id = p_tenant_id) then
    raise exception 'приём не найден' using errcode='P0002';
  end if;
  res := visit_detail(p_visit_id);
  perform log_access(p_tenant_id, p_actor, 'visit', p_visit_id);
  return res;
end $$;

-- Поиск по базе пациентов пишем только когда он ЕСТЬ: открытие списка это
-- рабочая рутина, а перебор по фамилиям — уже вопрос.
create or replace function public.patients_overview(
  p_tenant_id uuid, p_query text default '', p_limit int default 60, p_actor text default null)
returns table(
  id uuid, full_name text, phone text, visits bigint, last_visit date,
  total_revenue numeric, next_at timestamptz, in_telegram boolean)
language plpgsql security definer set search_path to 'public','extensions' as $$
begin
  if coalesce(trim(p_query), '') <> '' and p_actor is not null then
    perform log_access(p_tenant_id, p_actor, 'patient_search', null, trim(p_query));
  end if;

  return query
  select p.id, p.full_name, p.phone,
         count(distinct v.id),
         max(v.visit_date),
         coalesce(sum(vs.price), 0),
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
end $$;

-- Старые версии без актора закрываем: маршрут, забывший передать, кто
-- спрашивает, должен падать, а не тихо не писать в журнал.
revoke all on function public.patient_card(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.visit_detail(uuid, uuid) from public, anon, authenticated, service_role;

/** Кто открывал карту. Показываем врачу, если в кабинете не он один. */
create or replace function public.patient_access_log(
  p_tenant_id uuid, p_patient_id uuid, p_limit int default 20)
returns table(subject text, action text, detail text, at timestamptz)
language sql stable security definer set search_path to 'public','extensions' as $$
  select l.subject, l.action, l.detail, l.at
    from access_log l
   where l.tenant_id = p_tenant_id and l.target_id = p_patient_id
   order by l.at desc
   limit greatest(1, least(p_limit, 100));
$$;

/**
 * Чистка журнала.
 *
 * Два года — срок, за который обычно всплывает спор о лечении. Удалять
 * раньше значит остаться без доказательства; хранить вечно — растить
 * таблицу, которую никто не читает. Срок вынесен в аргумент: это решение
 * владельца, а не свойство кода.
 */
create or replace function public.prune_access_log(p_keep_days int default 730)
returns int
language plpgsql security definer set search_path to 'public','extensions' as $$
declare n int;
begin
  delete from access_log where at < now() - make_interval(days => p_keep_days);
  get diagnostics n = row_count;
  return n;
end $$;

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
       'set_verified_phone', 'normalize_phone',
       'provision_tenant', 'provision_tenant_core', 'available_templates',
       'template_health', 'subscription_plans_list', 'due_subscription_notices',
       'rls_health', 'prune_access_log'
     )
     and has_function_privilege('service_role', p.oid, 'execute')
   order by p.proname;
$$;;
