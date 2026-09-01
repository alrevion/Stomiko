-- 044_user_context_onboarding (применена 20260901113407)

-- 044: состояние знакомства едет вместе с кабинетом.
--
-- Приложение узнаёт про обучение из того же запроса, что определяет вход,
-- а не отдельным обращением: лишний круг до Франкфурта на каждом открытии
-- заметен, а знание нужно сразу — от него зависит, что рисовать первым.
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
$$;;
