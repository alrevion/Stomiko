-- 029_demo_repeat_patients (применена 20260828163814)

-- 029: правдоподобное распределение повторных визитов.
--
-- После 028 у всех выходило по одному-двум приёмам. У кабинета, работающего
-- не первый месяц, так не бывает: лечение канала — это два-три визита, а не
-- один. Карточка пациента без истории ничего не показывает.
do $$
declare
  t uuid; pool uuid[]; v record; target uuid; i int := 0; n int;
begin
  select id into t from tenants limit 1;

  -- Ядро постоянных: 22 человека, к которым стягиваем часть потока.
  select array_agg(id) into pool from (
    select p.id from patients p
     where p.tenant_id = t and p.full_name <> '— занято —'
     order by p.created_at limit 22) q;
  n := array_length(pool, 1);

  for v in
    select vi.id, vi.visit_date, vi.patient_id
      from visits vi where vi.tenant_id = t order by vi.visit_date, vi.id
  loop
    i := i + 1;
    -- Каждый второй приём — к постоянному пациенту, если в этот день он
    -- ещё не приходил.
    continue when i % 2 = 1;
    target := pool[1 + (i / 2) % n];
    continue when target = v.patient_id;
    continue when exists (
      select 1 from visits x where x.patient_id = target and x.visit_date = v.visit_date);

    update visits set patient_id = target where id = v.id;
    update appointments set patient_id = target
     where id = (select appointment_id from visits where id = v.id);
  end loop;

  delete from patients p
   where p.tenant_id = t
     and p.full_name <> '— занято —'
     and not exists (select 1 from visits x where x.patient_id = p.id)
     and not exists (select 1 from appointments a where a.patient_id = p.id);
end $$;;
