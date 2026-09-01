-- 041_template_health (применена 20260901112803)

-- 041: сторож за расхождением шаблона и справочника.
--
-- Шаблон снят с действующего кабинета. Если справочник кабинета поправят,
-- а шаблон нет, новый врач получит НЕ ТО, что работает у первого — и
-- разойдётся это молча, обнаружившись на чужой себестоимости.
--
-- Отдельно ловим висячие ссылки: строка техкарты, указывающая на материал
-- или блок, которых в шаблоне нет, при разворачивании кабинета просто
-- исчезнет — норма пропадёт, а себестоимость окажется занижена.
create or replace function public.template_health()
returns jsonb
language sql stable security definer set search_path to 'public','extensions' as $$
  with tpl as (select id from catalog_templates where code = 'therapist'),
       ten as (select id from tenants order by created_at limit 1)
  select jsonb_build_object(
    'units',    (select count(*) from template_units where template_id = (select id from tpl)),
    'materials',(select count(*) from template_materials where template_id = (select id from tpl)),
    'services', (select count(*) from template_services where template_id = (select id from tpl)),
    'blocks',   (select count(*) from template_blocks where template_id = (select id from tpl)),
    'materials_without_price',
      (select count(*) from template_materials
        where template_id = (select id from tpl) and reference_price is null),
    'services_without_techcard',
      (select count(*) from template_services
        where template_id = (select id from tpl) and techcard_name_ru is null),
    -- Строка ссылается на материал, группу или блок, которых в шаблоне нет.
    'orphan_lines', (
      select count(*) from template_techcard_lines l
        join template_services s on s.id = l.service_id and s.template_id = (select id from tpl)
       where (l.material_name is not null and not exists (
               select 1 from template_materials m
                where m.template_id = (select id from tpl) and m.name_ru = l.material_name))
          or (l.analog_group_name is not null and not exists (
               select 1 from template_analog_groups g
                where g.template_id = (select id from tpl) and g.name = l.analog_group_name))
          or (l.block_code is not null and not exists (
               select 1 from template_blocks b
                where b.template_id = (select id from tpl) and b.code = l.block_code))
          or (l.unit_code is not null and not exists (
               select 1 from template_units u
                where u.template_id = (select id from tpl) and u.code = l.unit_code))),
    'tenant_materials', (select count(*) from materials where tenant_id = (select id from ten)),
    'tenant_services',  (select count(*) from services  where tenant_id = (select id from ten))
  );
$$;

create or replace function public.audit_tenant_guards()
returns table(имя text, аргументы text, причина text)
language sql stable security definer
set search_path to 'public','extensions','pg_catalog' as $$
  select p.proname::text, pg_get_function_arguments(p.oid),
         'достижима снаружи и не проверяет кабинет'
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef and p.prokind = 'f'
     and pg_get_function_arguments(p.oid) not like '%p_tenant_id%'
     and p.proname not in (
       'due_reminders', 'mark_reminded', 'redeem_staff_invite',
       'new_public_token', 'rotate_public_token', 'audit_tenant_guards',
       'touch_app_user', 'user_context', 'set_user_mode', 'my_appointments',
       'set_verified_phone', 'normalize_phone',
       'provision_tenant', 'available_templates',
       'template_health'   -- считает шаблон, данных кабинета не читает
     )
     and has_function_privilege('service_role', p.oid, 'execute')
   order by p.proname;
$$;;
