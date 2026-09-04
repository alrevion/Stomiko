-- 074_tooth_belongs_to_the_service

-- Зуб переезжает туда, где он и происходит: к ОКАЗАННОЙ услуге.
--
-- До сих пор зуб жил только в пункте плана лечения. Из-за этого история
-- человека молчала о зубе всякий раз, когда врач лечил без плана, — а без
-- плана работает почти весь приём «пришёл с болью, полечили». Клиническая
-- запись без зуба для следующего врача почти бесполезна: он видит, что
-- пломба была, и не видит где.
--
-- Хуже другое. Пункт плана подбирался ТОЛЬКО по услуге: план «пломба 26,
-- пломба 36», одна поставленная пломба — и закрывался первый пункт по
-- порядку. В карту уходил зуб 26, даже если лечили 36. Это не неточность
-- отображения, это неверная медицинская запись, которую нельзя исправить,
-- а только дополнить.

alter table visit_services
  add column if not exists tooth text
  check (tooth is null or tooth ~ '^[1-8][1-8]$');

comment on column visit_services.tooth is
  'Номер зуба по FDI: 11–48 постоянные, 51–85 молочные. Источник истины для истории.';

-- Что уже связано с планом — переносим оттуда: этот зуб врач указывал сам.
update visit_services vs
   set tooth = i.tooth
  from treatment_plan_items i
 where i.visit_service_id = vs.id and vs.tooth is null and i.tooth is not null;

/**
 * Закрытие пунктов плана оказанными услугами.
 *
 * Тело из 054b; изменён подбор пункта. Теперь зуб участвует в сопоставлении:
 * услуга с зубом закрывает пункт с ТЕМ ЖЕ зубом или пункт без зуба, и
 * никогда — пункт про другой зуб. Если подходящего пункта нет, он остаётся
 * запланированным: незакрытый пункт врач увидит и поправит, а запись про
 * чужой зуб не увидит никто, пока не станет поздно.
 */
create or replace function public.tg_close_plan_items() returns trigger
language plpgsql security definer set search_path to 'public','extensions' as $$
declare vs record;
begin
  for vs in select * from visit_services where visit_id = new.id order by created_at, id loop
    update treatment_plan_items i
       set status = 'done', done_at = now(), visit_service_id = vs.id
     where i.id = (
       select i2.id from treatment_plan_items i2
         join treatment_plans pl on pl.id = i2.plan_id
        where pl.tenant_id = new.tenant_id
          and pl.patient_id = new.patient_id
          and pl.status = 'active'
          and i2.status = 'planned'
          and i2.service_id = vs.service_id
          and (vs.tooth is null or i2.tooth is null or i2.tooth = vs.tooth)
        -- Точное совпадение по зубу вперёд: пункт без зуба берётся только
        -- тогда, когда своего пункта у этого зуба нет.
        order by (i2.tooth is distinct from vs.tooth), i2.stage, i2.position, i2.created_at
        limit 1);
  end loop;

  update treatment_plans pl
     set status = 'done', closed_at = now()
   where pl.tenant_id = new.tenant_id and pl.patient_id = new.patient_id
     and pl.status = 'active'
     and not exists (select 1 from treatment_plan_items i
                      where i.plan_id = pl.id and i.status = 'planned');
  return null;
end $$;

/**
 * Запечатывание. Тело из 065; изменён только источник зуба.
 *
 * Сначала зуб самой услуги, и лишь потом — пункт плана, который она закрыла.
 * Порядок именно такой: врач указал зуб на приёме, глядя в рот, а план
 * писался заранее и мог измениться прямо в кресле.
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
         coalesce(vs.tooth,
           (select i.tooth from treatment_plan_items i where i.visit_service_id = vs.id)),
         vs.quantity
    from visit_services vs
    join services s on s.id = vs.service_id
   where vs.visit_id = new.id
  on conflict (visit_service_id) do nothing;

  return null;
end $$;

/** Зуб в разборе приёма. Тело из 027; добавлено одно поле. */
create or replace function public.visit_detail(p_visit_id uuid)
returns jsonb
language sql stable security definer set search_path to 'public','extensions' as $$
  select jsonb_build_object(
    'id', v.id,
    'status', v.status,
    'visitDate', v.visit_date,
    'closedAt', v.closed_at,
    'patientId', p.id,
    'patient', p.full_name,
    'phone', p.phone,
    'appointmentId', v.appointment_id,
    'services', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', vs.id, 'name', s.name_ru, 'quantity', vs.quantity,
               'price', vs.price, 'tooth', vs.tooth)
               order by s.name_ru)
        from visit_services vs join services s on s.id = vs.service_id
       where vs.visit_id = v.id), '[]'::jsonb),
    'revenue', coalesce((select sum(vs.price) from visit_services vs where vs.visit_id = v.id), 0),
    'cost', (select vc.materials_total from visit_costs vc
              where vc.visit_id = v.id and vc.superseded_at is null),
    'hasUnpriced', coalesce((select vc.has_unpriced from visit_costs vc
              where vc.visit_id = v.id and vc.superseded_at is null), false)
  )
  from visits v join patients p on p.id = v.patient_id
  where v.id = p_visit_id;
$$;

/**
 * Проставить зуб оказанной услуге — пока приём открыт.
 *
 * Правило здесь, а не в маршруте: после закрытия приёма запись запечатана,
 * и менять то, из чего она собрана, значит менять её задним числом.
 */
create or replace function public.set_visit_service_tooth(
  p_tenant_id uuid, p_visit_service_id uuid, p_tooth text)
returns jsonb
language plpgsql volatile security definer set search_path to 'public','extensions' as $$
declare v_status text; v_tooth text;
begin
  v_tooth := nullif(trim(coalesce(p_tooth, '')), '');
  if v_tooth is not null and v_tooth !~ '^[1-8][1-8]$' then
    raise exception '«%» — не номер зуба по FDI. Например 26.', v_tooth using errcode='P0001';
  end if;

  select v.status into v_status
    from visit_services vs join visits v on v.id = vs.visit_id
   where vs.id = p_visit_service_id and vs.tenant_id = p_tenant_id;
  if v_status is null then raise exception 'услуга не найдена' using errcode='P0002'; end if;
  if v_status <> 'open' then
    raise exception 'приём закрыт — запись уже запечатана, её можно только дополнить'
      using errcode='P0001';
  end if;

  update visit_services set tooth = v_tooth
   where id = p_visit_service_id and tenant_id = p_tenant_id;
  return jsonb_build_object('id', p_visit_service_id, 'tooth', v_tooth);
end $$;

revoke all on function public.set_visit_service_tooth(uuid,uuid,text) from public, anon, authenticated;
