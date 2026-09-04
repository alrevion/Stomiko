-- 066_backfill_clinical_history (применена 20260904133812)

-- 066_backfill_clinical_history
--
-- Шаг 3: уже закрытые приёмы становятся историей человека.
--
-- Переносятся только приёмы пациентов с подтверждённым Telegram: остальных
-- мы не можем опознать, и отдавать их карту некому. Демо-приёмы не
-- переносятся — они выдуманные и стираются при завершении знакомства.
--
-- Идемпотентно: одна оказанная услуга — одна запись, это держит
-- частичный уникальный индекс clinical_one_per_service.

create or replace function public.backfill_clinical_history()
returns jsonb
language plpgsql volatile security definer set search_path to 'public','extensions' as $$
declare created int; expected int; got int;
begin
  insert into clinical_entries (
    person_subject, author_tenant_id, author_cabinet, author_doctor,
    visit_id, visit_service_id, occurred_on, service_name, tooth, quantity, sealed_at)
  select p.telegram_subject, v.tenant_id, t.name,
         (select r.name from resources r
           where r.tenant_id = v.tenant_id and r.kind = 'practitioner'
             and r.name not in ('Врач','Доктор','') limit 1),
         v.id, vs.id, v.visit_date, s.name_ru,
         (select i.tooth from treatment_plan_items i where i.visit_service_id = vs.id),
         vs.quantity,
         -- Запечатано тогда, когда приём закрыли, а не сейчас: иначе вся
         -- история получила бы сегодняшнюю дату и перестала быть историей.
         coalesce(v.closed_at, v.created_at)
    from visits v
    join visit_services vs on vs.visit_id = v.id
    join services s on s.id = vs.service_id
    join patients p on p.id = v.patient_id
    join tenants t on t.id = v.tenant_id
   where v.status = 'closed'
     and not v.is_demo
     and p.telegram_subject is not null
  on conflict (visit_service_id) do nothing;
  get diagnostics created = row_count;

  -- Сверка: сколько услуг подлежало переносу и сколько записей вышло.
  select count(*) into expected
    from visits v
    join visit_services vs on vs.visit_id = v.id
    join patients p on p.id = v.patient_id
   where v.status = 'closed' and not v.is_demo and p.telegram_subject is not null;

  select count(*) into got
    from clinical_entries e where e.visit_service_id is not null;

  return jsonb_build_object('created', created, 'expected', expected, 'entries', got,
                            'reconciled', expected = got);
end $$;

revoke all on function public.backfill_clinical_history() from public, anon, authenticated;

/**
 * Сторож переносимой истории.
 *
 * Проверяет то, что легко разъезжается молча: у каждой оказанной услуги
 * опознанного пациента есть ровно одна запись, ни одна запись не потеряла
 * владельца, дополнения ссылаются на существующее.
 */
create or replace function public.clinical_health()
returns jsonb
language sql stable security definer set search_path to 'public','extensions' as $$
  select jsonb_build_object(
    'entries', (select count(*) from clinical_entries),
    'amendments', (select count(*) from clinical_entries where amends is not null),
    'people', (select count(distinct person_subject) from clinical_entries),
    'cabinets_gone', (select count(*) from clinical_entries where author_tenant_id is null),
    -- Услуги, которые должны были дать запись, но не дали.
    'missing', (select count(*)
        from visits v
        join visit_services vs on vs.visit_id = v.id
        join patients p on p.id = v.patient_id
       where v.status = 'closed' and not v.is_demo and p.telegram_subject is not null
         and not exists (select 1 from clinical_entries e where e.visit_service_id = vs.id)),
    -- Дополнения, потерявшие исходную запись.
    'orphan_amendments', (select count(*) from clinical_entries e
       where e.amends is not null
         and not exists (select 1 from clinical_entries o where o.id = e.amends)));
$$;

revoke all on function public.clinical_health() from public, anon, authenticated;;
