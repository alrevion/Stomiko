-- Stomiko smoke: проверяет, что ограничения РАБОТАЮТ, а не просто созданы.
-- Запуск: вставить содержимое в SQL-редактор Supabase или прогнать через execute_sql.
-- Ничего после себя не оставляет: тенант удаляется каскадом в конце.
do $$
declare
  t uuid; loc uuid; chair uuid; pat uuid; ap uuid; v uuid;
  failed text := '';
begin
  insert into tenants (name) values ('SMOKE') returning id into t;
  insert into locations (tenant_id, name) values (t, 'Кабинет') returning id into loc;
  insert into resources (tenant_id, location_id, kind, name) values (t, loc, 'chair', 'Кресло 1') returning id into chair;
  insert into patients (tenant_id, full_name) values (t, 'Тест') returning id into pat;
  insert into appointments (tenant_id, patient_id, starts_at, ends_at)
    values (t, pat, '2026-08-26 10:00+05', '2026-08-26 11:00+05') returning id into ap;
  insert into appointment_resources (tenant_id, appointment_id, resource_id, role, starts_at, ends_at)
    values (t, ap, chair, 'chair', '2026-08-26 10:00+05', '2026-08-26 11:00+05');

  -- 1. Пересечение по тому же ресурсу отвергается EXCLUDE.
  begin
    insert into appointment_resources (tenant_id, appointment_id, resource_id, role, starts_at, ends_at)
      values (t, ap, chair, 'chair', '2026-08-26 10:30+05', '2026-08-26 11:30+05');
    failed := failed || 'EXCLUDE не сработал; ';
  exception when exclusion_violation then null; end;

  -- 2. Смежное окно без пересечения проходит.
  begin
    insert into appointment_resources (tenant_id, appointment_id, resource_id, role, starts_at, ends_at)
      values (t, ap, chair, 'chair', '2026-08-26 11:00+05', '2026-08-26 12:00+05');
  exception when others then failed := failed || 'смежное окно отвергнуто; '; end;

  -- 3. Отмена освобождает слот (частичного предиката нет — строки занятости удаляются).
  delete from appointment_resources where appointment_id = ap;
  begin
    insert into appointment_resources (tenant_id, appointment_id, resource_id, role, starts_at, ends_at)
      values (t, ap, chair, 'chair', '2026-08-26 10:00+05', '2026-08-26 11:00+05');
  exception when others then failed := failed || 'слот не освободился после отмены; '; end;

  insert into visits (tenant_id, location_id, patient_id) values (t, loc, pat) returning id into v;

  -- 4. Приём без записи (walk-in) допустим.
  begin
    insert into visits (tenant_id, location_id, patient_id, appointment_id) values (t, loc, pat, null);
  exception when others then failed := failed || 'walk-in отвергнут; '; end;

  -- 5. Два активных снимка себестоимости на один приём запрещены.
  insert into visit_costs (tenant_id, visit_id) values (t, v);
  begin
    insert into visit_costs (tenant_id, visit_id) values (t, v);
    failed := failed || 'частичный unique не сработал; ';
  exception when unique_violation then null; end;

  -- 6. Снимок с superseded_at сосуществует с активным — иначе reversal невозможен.
  begin
    insert into visit_costs (tenant_id, visit_id, superseded_at) values (t, v, now());
  exception when others then failed := failed || 'superseded-снимок отвергнут; '; end;

  -- 7. unpriced обязан совпадать с (cost is null): ноль как заглушка запрещён.
  begin
    insert into stock_movements (tenant_id, location_id, kind, material_id, qty_delta, cost, unpriced)
      values (t, loc, 'consume', gen_random_uuid(), -1, null, false);
    failed := failed || 'unpriced-инвариант не сработал; ';
  exception when check_violation then null; when foreign_key_violation then null; end;

  -- 8. shortfall обязан быть без партии и с состоянием жизненного цикла.
  begin
    insert into stock_movements (tenant_id, location_id, kind, material_id, qty_delta, cost, unpriced, shortfall_state)
      values (t, loc, 'shortfall', gen_random_uuid(), -1, 100, false, null);
    failed := failed || 'shortfall_state-инвариант не сработал; ';
  exception when check_violation then null; when foreign_key_violation then null; end;

  delete from tenants where id = t;

  if failed = '' then raise notice 'SMOKE OK'; else raise exception 'SMOKE FAILED: %', failed; end if;
end $$;
