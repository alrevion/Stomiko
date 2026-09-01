-- 042_onboarding_and_demo_marking (применена 20260901113155)

-- 042: обучение на демо-данных и точная их очистка.
--
-- Врач при регистрации получает кабинет, наполненный выдуманной работой:
-- на пустом складе и пустом календаре показывать нечего, а именно отчёт
-- «сверх материалов по услугам» и продаёт продукт.
--
-- Демо-строки ПОМЕЧАЮТСЯ. Без метки очистка превращается в угадывание по
-- датам и именам, а угадывание однажды сотрёт настоящий приём — тот самый,
-- который врач провёл, не дождавшись конца обучения.
alter table patients     add column if not exists is_demo boolean not null default false;
alter table appointments add column if not exists is_demo boolean not null default false;
alter table visits       add column if not exists is_demo boolean not null default false;
alter table batches      add column if not exists is_demo boolean not null default false;

create index if not exists patients_demo_idx     on patients (tenant_id) where is_demo;
create index if not exists appointments_demo_idx on appointments (tenant_id) where is_demo;
create index if not exists visits_demo_idx       on visits (tenant_id) where is_demo;
create index if not exists batches_demo_idx      on batches (tenant_id) where is_demo;

-- Состояние знакомства с кабинетом. Хранится у кабинета, а не у человека:
-- пригласят ассистента — он увидит уже настроенный кабинет, а не обучение.
alter table tenants add column if not exists onboarding jsonb not null
  default jsonb_build_object('active', false, 'seen', '[]'::jsonb);
alter table tenants add column if not exists catalog_reviewed_at timestamptz;

/** Отметить пройденный экран. Список закрытый: опечатка не должна копиться. */
create or replace function public.onboarding_seen(p_tenant_id uuid, p_screen text)
returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare cur jsonb;
begin
  if p_screen not in ('calendar','visit','stock','techcards','margin','link') then
    return (select onboarding from tenants where id = p_tenant_id);
  end if;
  update tenants
     set onboarding = jsonb_set(onboarding, '{seen}',
           (select jsonb_agg(distinct x) from jsonb_array_elements(
              coalesce(onboarding->'seen', '[]'::jsonb) || to_jsonb(p_screen)) x))
   where id = p_tenant_id and coalesce((onboarding->>'active')::boolean, false)
  returning onboarding into cur;
  return coalesce(cur, (select onboarding from tenants where id = p_tenant_id));
end $$;

/**
 * Конец обучения: выдуманная работа стирается, СПРАВОЧНИК остаётся.
 *
 * Это и есть смысл шага. Если стереть заодно материалы и техкарты, врач
 * останется перед пустым экраном и уйдёт; если не стереть приёмы — начнёт
 * работать поверх выдуманных цифр и однажды предъявит их как свои.
 */
create or replace function public.wipe_demo(p_tenant_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare v_visits int; v_patients int; v_appts int; v_batches int;
begin
  -- Движения и снимки себестоимости уходят вместе с приёмами, которые их
  -- породили: у самих движений метки нет, она была бы дублированием правды.
  delete from visit_costs where visit_id in
    (select id from visits where tenant_id = p_tenant_id and is_demo);
  delete from stock_movements where visit_id in
    (select id from visits where tenant_id = p_tenant_id and is_demo);
  delete from stock_movements where batch_id in
    (select id from batches where tenant_id = p_tenant_id and is_demo);
  delete from visit_services where visit_id in
    (select id from visits where tenant_id = p_tenant_id and is_demo);

  delete from visits where tenant_id = p_tenant_id and is_demo;
  get diagnostics v_visits = row_count;

  delete from appointment_resources where appointment_id in
    (select id from appointments where tenant_id = p_tenant_id and is_demo);
  delete from appointments where tenant_id = p_tenant_id and is_demo;
  get diagnostics v_appts = row_count;

  delete from batches where tenant_id = p_tenant_id and is_demo;
  get diagnostics v_batches = row_count;

  -- Пациента удаляем только если за ним ничего настоящего не осталось.
  delete from patients p where p.tenant_id = p_tenant_id and p.is_demo
    and not exists (select 1 from visits v where v.patient_id = p.id)
    and not exists (select 1 from appointments a where a.patient_id = p.id);
  get diagnostics v_patients = row_count;

  update tenants
     set onboarding = jsonb_build_object('active', false, 'seen', '[]'::jsonb,
                                         'finishedAt', to_jsonb(now()))
   where id = p_tenant_id;

  return jsonb_build_object('visits', v_visits, 'appointments', v_appts,
                            'patients', v_patients, 'batches', v_batches);
end $$;

/** Врач подтвердил, что сверил материалы и цены. */
create or replace function public.mark_catalog_reviewed(p_tenant_id uuid)
returns void
language sql security definer set search_path to 'public','extensions' as $$
  update tenants set catalog_reviewed_at = now() where id = p_tenant_id;
$$;

-- provision_tenant теперь включает режим обучения.
create or replace function public.start_onboarding(p_tenant_id uuid)
returns void
language sql security definer set search_path to 'public','extensions' as $$
  update tenants
     set onboarding = jsonb_build_object('active', true, 'seen', '[]'::jsonb)
   where id = p_tenant_id;
$$;;
