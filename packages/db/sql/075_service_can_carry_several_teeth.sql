-- 075_service_can_carry_several_teeth

-- У оказанной услуги теперь СПИСОК зубов, а не один.
--
-- В 074 зуб был один, и «поставил две пломбы» приходилось вносить дважды.
-- Это ровно тот случай, ради которого систему и покупают: внести быстрее,
-- чем записать на бумаге. Два прохода по одному и тому же экрану — это не
-- «редкий случай», это приём.
--
-- Почему не две строки услуг вместо списка. Себестоимость считается по
-- техкарте как база плюс расход на единицу; база — это то, что тратится
-- РАЗ ЗА ПРИЁМ: анестезия, перчатки, изоляция. Две строки списали бы базу
-- дважды и завысили материалы, а вместе с ними занизили «сверх материалов».
-- Одна строка на N зубов считает честно.
--
-- В клинической записи зуб остаётся один: карта человека по своей природе
-- по-зубная, и «пломба на 26 и 36» одной строкой не читается следующим
-- врачом. Триггер разворачивает список в отдельные записи.

alter table visit_services add column if not exists teeth text[] not null default '{}';

-- Проверка списка выражением, а не подзапросом: подзапросы в CHECK
-- запрещены, а склейка через запятую проверяется тем же правилом FDI.
alter table visit_services drop constraint if exists visit_services_teeth_fdi;
alter table visit_services add constraint visit_services_teeth_fdi
  check (array_to_string(teeth, ',') ~ '^([1-8][1-8](,[1-8][1-8])*)?$');

update visit_services set teeth = array[tooth] where tooth is not null and teeth = '{}';
alter table visit_services drop column if exists tooth;

comment on column visit_services.teeth is
  'Зубы по FDI (11–48 постоянные, 51–85 молочные). Пусто — услуга не про зуб.';

/**
 * Одна клиническая запись на ЗУБ, а не на строку услуги.
 *
 * Уникальность переезжает с visit_service_id на пару с зубом, иначе второй
 * зуб той же услуги не запечатался бы вовсе. `nulls not distinct` нужен для
 * услуг без зуба: иначе повторное закрытие приёма создало бы дубль, потому
 * что null не равен null. Предикат исключает дополнения — у них
 * visit_service_id пуст, и двух дополнений быть не должно только по паре.
 *
 * Предикат частичного индекса ПОВТОРЯЕТСЯ в on conflict ниже: без этого
 * Postgres не признаёт индекс арбитром (42P10). На этом я уже спотыкался
 * в 067 — и тогда падало бы закрытие приёма у всех врачей.
 */
drop index if exists clinical_one_per_service;
create unique index clinical_one_per_service_tooth
  on clinical_entries (visit_service_id, tooth)
  nulls not distinct
  where visit_service_id is not null;

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
         -- Зуб услуги; если их не проставили — зуб пункта плана, который эта
         -- услуга закрыла. Список пустой — запись без зуба, одна.
         coalesce(z.tooth,
           (select i.tooth from treatment_plan_items i where i.visit_service_id = vs.id)),
         -- Количество делится по зубам: «две пломбы» это две записи по одной,
         -- а «три канала одного зуба» — одна запись с тройкой.
         case when coalesce(array_length(vs.teeth, 1), 0) > 1 then 1 else vs.quantity end
    from visit_services vs
    join services s on s.id = vs.service_id
    left join lateral unnest(
      case when coalesce(array_length(vs.teeth, 1), 0) = 0
           then array[null]::text[] else vs.teeth end) as z(tooth) on true
   where vs.visit_id = new.id
  on conflict (visit_service_id, tooth) where visit_service_id is not null do nothing;

  return null;
end $$;

/**
 * Закрытие пунктов плана. Тело из 074; теперь по каждому зубу услуги.
 *
 * Пункт плана всегда про один зуб, поэтому услуга на два зуба закрывает два
 * пункта, а не один. Порядок прежний: точное совпадение по зубу вперёд,
 * пункт про ЧУЖОЙ зуб не закрывается никогда.
 */
create or replace function public.tg_close_plan_items() returns trigger
language plpgsql security definer set search_path to 'public','extensions' as $$
declare vs record; z text; list text[];
begin
  for vs in select * from visit_services where visit_id = new.id order by created_at, id loop
    -- Услуга без зубов всё равно должна пройти круг один раз: список из
    -- одного null, а не пустой, иначе такие услуги перестали бы закрывать
    -- пункты плана вообще.
    list := case when coalesce(array_length(vs.teeth, 1), 0) = 0
                 then array[null]::text[] else vs.teeth end;
    foreach z in array list loop
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
            and (z is null or i2.tooth is null or i2.tooth = z)
          order by (i2.tooth is distinct from z), i2.stage, i2.position, i2.created_at
          limit 1);
    end loop;
  end loop;

  update treatment_plans pl
     set status = 'done', closed_at = now()
   where pl.tenant_id = new.tenant_id and pl.patient_id = new.patient_id
     and pl.status = 'active'
     and not exists (select 1 from treatment_plan_items i
                      where i.plan_id = pl.id and i.status = 'planned');
  return null;
end $$;

/** Зубы в разборе приёма. Тело из 074; поле стало списком. */
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
               'price', vs.price, 'teeth', to_jsonb(vs.teeth))
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
 * Проставить зубы оказанной услуге — пока приём открыт.
 *
 * Заменяет set_visit_service_tooth из 074: та принимала один зуб и в новой
 * модели врала бы самим своим именем.
 */
drop function if exists public.set_visit_service_tooth(uuid,uuid,text);

create or replace function public.set_visit_service_teeth(
  p_tenant_id uuid, p_visit_service_id uuid, p_teeth text[])
returns jsonb
language plpgsql volatile security definer set search_path to 'public','extensions' as $$
declare v_status text; v_teeth text[]; z text;
begin
  v_teeth := coalesce(p_teeth, '{}');
  foreach z in array v_teeth loop
    if z !~ '^[1-8][1-8]$' then
      raise exception '«%» — не номер зуба по FDI. Например 26.', z using errcode='P0001';
    end if;
  end loop;

  select v.status into v_status
    from visit_services vs join visits v on v.id = vs.visit_id
   where vs.id = p_visit_service_id and vs.tenant_id = p_tenant_id;
  if v_status is null then raise exception 'услуга не найдена' using errcode='P0002'; end if;
  if v_status <> 'open' then
    raise exception 'приём закрыт — запись уже запечатана, её можно только дополнить'
      using errcode='P0001';
  end if;

  update visit_services set teeth = v_teeth
   where id = p_visit_service_id and tenant_id = p_tenant_id;
  return jsonb_build_object('id', p_visit_service_id, 'teeth', to_jsonb(v_teeth));
end $$;

revoke all on function public.set_visit_service_teeth(uuid,uuid,text[]) from public, anon, authenticated;
