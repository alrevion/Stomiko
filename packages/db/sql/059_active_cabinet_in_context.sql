-- 059_active_cabinet_in_context

-- Кабинет, выбранный в поиске, не становился активным.
--
-- Пациентом кабинета человек считался только там, где есть его карточка, а
-- карточка заводится при первой записи. Выбрал кабинет из поиска — карточки
-- ещё нет, значит «нигде», и приложение возвращало его обратно в поиск.
-- Замкнутый круг: чтобы записаться, надо быть записанным.
--
-- Завести карточку прямо при выборе было бы проще, но неверно: список
-- пациентов врача заполнился бы теми, кто только посмотрел.
--
-- Контекст теперь несёт и сам выбранный кабинет. Отдаётся он ТОЛЬКО если
-- человек вправе им пользоваться: кабинет открыт для поиска, либо у человека
-- там карточка или членство. Иначе знание идентификатора давало бы вход.
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

revoke all on function public.user_context(text) from public, anon, authenticated;
