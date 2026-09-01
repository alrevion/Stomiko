-- 046_provision_tenant_core (применена 20260901114341)

-- 046: разделение создания кабинета и подписки.
--
-- В 045 я подменил provision_tenant обёрткой, вызывающей provision_tenant_core,
-- но самой core не создал: кабинет перестал бы заводиться вовсе. Поймано
-- проверкой, а не чтением — ровно тот случай, когда правка «на ходу» ломает
-- то, что только что работало.
--
-- Ядро создаёт кабинет, обёртка добавляет пробный период: подписка не дело
-- провизионера, и смешивать их значит чинить одно, ломая другое.
create or replace function public.provision_tenant_core(
  p_subject text,
  p_name text,
  p_template_code text default 'therapist',
  p_doctor_name text default null)
returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare
  tpl uuid; t uuid; loc uuid; chair uuid; nm text; tok text; tcv uuid;
begin
  nm := nullif(trim(p_name), '');
  if nm is null then raise exception 'укажите название кабинета' using errcode='P0001'; end if;

  select id into tpl from catalog_templates
   where code = p_template_code and is_active;
  if tpl is null then
    raise exception 'справочник «%» пока не готов', p_template_code using errcode='P0002';
  end if;

  if exists (select 1 from memberships where subject = p_subject and role = 'owner') then
    raise exception 'у вас уже есть кабинет' using errcode='P0001';
  end if;

  insert into tenants (name) values (nm) returning id, public_token into t, tok;
  insert into locations (tenant_id, name) values (t, nm) returning id into loc;
  insert into resources (tenant_id, location_id, kind, name)
       values (t, loc, 'chair', 'Кресло 1') returning id into chair;
  insert into resources (tenant_id, location_id, kind, name)
       values (t, loc, 'practitioner', coalesce(nullif(trim(p_doctor_name), ''), 'Врач'));

  insert into units (tenant_id, code, name_ru, name_uz, factor, divisible)
  select t, tu.code, tu.name_ru, tu.name_uz, tu.factor, tu.divisible
    from template_units tu where tu.template_id = tpl;

  insert into materials (tenant_id, name_ru, name_uz, base_unit_id, category, reference_price)
  select t, tm.name_ru, tm.name_uz, u.id, tm.category, tm.reference_price
    from template_materials tm
    join units u on u.tenant_id = t and u.code = tm.unit_code
   where tm.template_id = tpl;

  insert into analog_groups (tenant_id, name)
  select t, tg.name from template_analog_groups tg where tg.template_id = tpl;

  insert into analog_group_members (group_id, material_id, priority)
  select ag.id, m.id, tam.priority
    from template_analog_members tam
    join template_analog_groups tg on tg.id = tam.group_id and tg.template_id = tpl
    join analog_groups ag on ag.tenant_id = t and ag.name = tg.name
    join materials m on m.tenant_id = t and m.name_ru = tam.material_name;

  insert into techcard_blocks (tenant_id, code, name_ru, name_uz)
  select t, tb.code, tb.name_ru, tb.name_uz
    from template_blocks tb where tb.template_id = tpl;

  insert into techcard_block_versions (block_id, version)
  select b.id, 1 from techcard_blocks b where b.tenant_id = t;

  insert into techcard_block_lines (block_version_id, material_id, norm_qty, unit_id, scales_with_quantity)
  select bv.id, m.id, tbl.norm_qty, u.id, tbl.scales_with_quantity
    from template_block_lines tbl
    join template_blocks tb on tb.id = tbl.block_id and tb.template_id = tpl
    join techcard_blocks b on b.tenant_id = t and b.code = tb.code
    join techcard_block_versions bv on bv.block_id = b.id and bv.version = 1
    join materials m on m.tenant_id = t and m.name_ru = tbl.material_name
    join units u on u.tenant_id = t and u.code = tbl.unit_code;

  insert into techcards (tenant_id, name_ru, name_uz)
  select distinct t, ts.techcard_name_ru, ts.techcard_name_ru
    from template_services ts
   where ts.template_id = tpl and ts.techcard_name_ru is not null;

  insert into techcard_versions (techcard_id, version)
  select tc.id, 1 from techcards tc where tc.tenant_id = t;

  insert into services (tenant_id, code, name_ru, name_uz, price, unit_of_norm,
                        duration_minutes, bookable, techcard_version_id)
  select t, ts.code, ts.name_ru, ts.name_uz, ts.price, ts.unit_of_norm,
         ts.duration_minutes, ts.bookable, tv.id
    from template_services ts
    left join techcards tc on tc.tenant_id = t and tc.name_ru = ts.techcard_name_ru
    left join techcard_versions tv on tv.techcard_id = tc.id and tv.version = 1
   where ts.template_id = tpl;

  insert into techcard_lines (techcard_version_id, material_id, analog_group_id,
                              norm_qty, unit_id, scales_with_quantity)
  select s.techcard_version_id, m.id, ag.id, ttl.norm_qty, u.id, ttl.scales_with_quantity
    from template_techcard_lines ttl
    join template_services ts on ts.id = ttl.service_id and ts.template_id = tpl
    join services s on s.tenant_id = t and s.name_ru = ts.name_ru
    left join materials m on m.tenant_id = t and m.name_ru = ttl.material_name
    left join analog_groups ag on ag.tenant_id = t and ag.name = ttl.analog_group_name
    left join units u on u.tenant_id = t and u.code = ttl.unit_code
   where ttl.block_code is null and s.techcard_version_id is not null;

  insert into techcard_lines (techcard_version_id, block_version_id)
  select s.techcard_version_id, bv.id
    from template_techcard_lines ttl
    join template_services ts on ts.id = ttl.service_id and ts.template_id = tpl
    join services s on s.tenant_id = t and s.name_ru = ts.name_ru
    join techcard_blocks b on b.tenant_id = t and b.code = ttl.block_code
    join techcard_block_versions bv on bv.block_id = b.id and bv.version = 1
   where ttl.block_code is not null and s.techcard_version_id is not null;

  for tcv in select tv.id from techcard_versions tv
             join techcards tc on tc.id = tv.techcard_id where tc.tenant_id = t
  loop
    perform expand_techcard_version(tcv);
  end loop;

  insert into working_hours (tenant_id, resource_id, weekday, starts_at, ends_at)
  select t, chair, wd, h.s, h.e
    from generate_series(1, 5) wd,
         (values (time '09:00', time '13:00'), (time '14:00', time '18:00')) h(s, e);

  insert into booking_settings (tenant_id, slot_step_minutes, min_notice_minutes,
                                max_days_ahead, buffer_minutes)
       values (t, 15, 120, 30, 10);

  insert into memberships (tenant_id, subject, role) values (t, p_subject, 'owner');
  insert into app_users (subject, active_mode, active_tenant_id, mode_chosen_at)
       values (p_subject, 'doctor', t, now())
  on conflict (subject) do update
     set active_mode = 'doctor', active_tenant_id = t, mode_chosen_at = now();

  return jsonb_build_object('tenantId', t, 'name', nm, 'publicToken', tok);
end $$;

-- Действующему кабинету пробный период не нужен — он уже работает.
insert into subscriptions (tenant_id, paid_until, status, plan_code)
select id, now() + interval '365 days', 'active', 'year' from tenants
on conflict (tenant_id) do nothing;;
