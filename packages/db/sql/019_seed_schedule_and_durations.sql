-- 019_seed_schedule_and_durations (применена 20260825102622)

do $$
declare t uuid; chair uuid;
begin
  select id into t from tenants limit 1;
  select id into chair from resources where tenant_id=t and kind='chair';

  insert into booking_settings (tenant_id) values (t) on conflict (tenant_id) do nothing;

  -- Пн–пт с обедом 13:00–14:00, суббота короткая, воскресенье выходной.
  -- Обед выражен двумя строками, а не дыркой внутри одной.
  delete from working_hours where tenant_id=t;
  insert into working_hours (tenant_id, resource_id, weekday, starts_at, ends_at)
  select t, chair, wd, s::time, e::time from (values
    (1,'09:00','13:00'),(1,'14:00','18:00'),
    (2,'09:00','13:00'),(2,'14:00','18:00'),
    (3,'09:00','13:00'),(3,'14:00','18:00'),
    (4,'09:00','13:00'),(4,'14:00','18:00'),
    (5,'09:00','13:00'),(5,'14:00','18:00'),
    (6,'10:00','14:00')
  ) as x(wd, s, e);

  -- Длительность приёма зависит от услуги: снимок — 10 минут, эндодонтия — час.
  update services set duration_minutes = case code
    when 'B01.065.007'    then 20
    when 'A06.07.003'     then 10
    when 'A16.07.002.009' then 20
    when 'A16.07.002.010' then 40
    when 'A16.07.002.011' then 60
    when 'A16.07.030.001' then 60
    when 'A16.07.008.002' then 45
    when 'A16.07.051'     then 45
    else 30 end
  where tenant_id = t;

  -- Рентген пациент сам не выбирает: назначается врачом по показаниям.
  update services set bookable = false where tenant_id=t and code='A06.07.003';
end $$;;
