-- 055_plan_activation_notice

-- План, который врач составил и никому не показал, не работает ни как
-- обещание, ни как инструмент продаж. Уведомить пациента должен воркер —
-- у функции БД нет доступа к Bot API, — но решить, НАДО ЛИ уведомлять,
-- может только она: только здесь видно, каким статус был до сохранения.
--
-- Поэтому функция возвращает `activated`: план только что стал видимым.
-- Иначе сообщение уходило бы при каждом сохранении активного плана, и врач,
-- поправивший цену, слал бы пациенту второе «врач составил план».
create or replace function public.save_treatment_plan(
  p_tenant_id uuid, p_plan_id uuid, p_patient_id uuid,
  p_title text, p_status text, p_note text, p_items jsonb, p_by text default null
) returns jsonb
language plpgsql volatile security definer set search_path to 'public','extensions' as $$
declare pid uuid; bad text; n int; was text; now_status text; subj text; cab text;
begin
  if coalesce(trim(p_title), '') = '' then
    raise exception 'у плана должно быть название' using errcode='P0001';
  end if;
  if p_status is not null and p_status not in ('draft','active','done','cancelled') then
    raise exception 'неизвестный статус плана' using errcode='P0001';
  end if;

  if p_plan_id is null then
    if not exists (select 1 from patients where id = p_patient_id and tenant_id = p_tenant_id) then
      raise exception 'пациент не найден' using errcode='P0002';
    end if;
    was := null;
    insert into treatment_plans (tenant_id, patient_id, title, status, note, created_by)
      values (p_tenant_id, p_patient_id, trim(p_title), coalesce(p_status,'draft'), p_note, p_by)
      returning id, status into pid, now_status;
  else
    select status into was from treatment_plans where id = p_plan_id and tenant_id = p_tenant_id;
    update treatment_plans
       set title = trim(p_title),
           status = coalesce(p_status, status),
           note = p_note,
           closed_at = case when coalesce(p_status, status) in ('done','cancelled')
                            then coalesce(closed_at, now()) else null end
     where id = p_plan_id and tenant_id = p_tenant_id
     returning id, status into pid, now_status;
    if pid is null then raise exception 'план не найден' using errcode='P0002'; end if;
  end if;

  select string_agg(x.sid::text, ', ') into bad
    from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) e
    cross join lateral (select (e->>'serviceId')::uuid as sid) x
   where not exists (select 1 from services s where s.id = x.sid and s.tenant_id = p_tenant_id);
  if bad is not null then
    raise exception 'услуга не из этого кабинета: %', bad using errcode='P0001';
  end if;

  delete from treatment_plan_items where plan_id = pid and status = 'planned';

  insert into treatment_plan_items
    (tenant_id, plan_id, service_id, tooth, quantity, price, stage, position)
  select p_tenant_id, pid, (e->>'serviceId')::uuid,
         nullif(trim(coalesce(e->>'tooth','')), ''),
         greatest(coalesce((e->>'quantity')::int, 1), 1),
         coalesce((e->>'price')::numeric,
                  (select s.price from services s where s.id = (e->>'serviceId')::uuid)),
         greatest(coalesce((e->>'stage')::int, 1), 1),
         (ord - 1)::int
    from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) with ordinality as t(e, ord);
  get diagnostics n = row_count;

  select p.telegram_subject, t.name into subj, cab
    from treatment_plans pl join patients p on p.id = pl.patient_id
    join tenants t on t.id = pl.tenant_id where pl.id = pid;

  return jsonb_build_object(
    'planId', pid, 'items', n, 'status', now_status,
    'activated', (now_status = 'active' and was is distinct from 'active' and n > 0),
    'telegramSubject', subj, 'cabinet', cab, 'title', trim(p_title));
end $$;

revoke all on function public.save_treatment_plan(uuid, uuid, uuid, text, text, text, jsonb, text)
  from public, anon, authenticated;
