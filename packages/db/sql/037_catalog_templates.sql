-- 037_catalog_templates (применена 20260901112132)

-- 037: справочник как шаблон, а не как единственный экземпляр.
--
-- Единицы, материалы, блоки, техкарты и услуги — тенантные. Справочник
-- существовал ровно в одном экземпляре и создавался миграциями 008–013 одним
-- блоком, который сам же и заводил кабинет. Второй кабинет наполнить было
-- нечем: врач при регистрации получал бы пустой склад и пустые техкарты.
--
-- Шаблон живёт ВНЕ тенантов и связывает свои части по кодам и названиям, а не
-- по идентификаторам: тогда копирование в новый кабинет — это обычные джойны
-- по естественным ключам, без таблиц соответствия и без порядка вставки.

create table catalog_templates (
  id         uuid primary key default gen_random_uuid(),
  code       text unique not null,
  name_ru    text not null,
  specialty  text not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create table template_units (
  id          uuid primary key default gen_random_uuid(),
  template_id uuid not null references catalog_templates(id) on delete cascade,
  code        text not null,
  name_ru     text not null,
  name_uz     text not null,
  factor      numeric not null default 1,
  divisible   boolean not null,
  unique (template_id, code)
);

create table template_materials (
  id              uuid primary key default gen_random_uuid(),
  template_id     uuid not null references catalog_templates(id) on delete cascade,
  name_ru         text not null,
  name_uz         text not null,
  category        text,
  unit_code       text not null,
  reference_price numeric,
  unique (template_id, name_ru)
);

create table template_analog_groups (
  id          uuid primary key default gen_random_uuid(),
  template_id uuid not null references catalog_templates(id) on delete cascade,
  name        text not null,
  unique (template_id, name)
);

create table template_analog_members (
  group_id      uuid not null references template_analog_groups(id) on delete cascade,
  material_name text not null,
  priority      int  not null default 1,
  primary key (group_id, material_name)
);

create table template_blocks (
  id          uuid primary key default gen_random_uuid(),
  template_id uuid not null references catalog_templates(id) on delete cascade,
  code        text not null,
  name_ru     text not null,
  name_uz     text not null,
  unique (template_id, code)
);

create table template_block_lines (
  id                  uuid primary key default gen_random_uuid(),
  block_id            uuid not null references template_blocks(id) on delete cascade,
  material_name       text not null,
  norm_qty            numeric not null,
  unit_code           text not null,
  scales_with_quantity boolean not null default false
);

create table template_services (
  id               uuid primary key default gen_random_uuid(),
  template_id      uuid not null references catalog_templates(id) on delete cascade,
  code             text,
  name_ru          text not null,
  name_uz          text not null,
  price            numeric not null,
  unit_of_norm     text not null default 'tooth',
  duration_minutes int not null default 30,
  bookable         boolean not null default true,
  techcard_name_ru text,
  unique (template_id, name_ru)
);

create table template_techcard_lines (
  id                   uuid primary key default gen_random_uuid(),
  service_id           uuid not null references template_services(id) on delete cascade,
  material_name        text,
  analog_group_name    text,
  block_code           text,
  norm_qty             numeric,
  unit_code            text,
  scales_with_quantity boolean not null default true,
  -- Строка либо своя (материал или группа аналогов), либо ссылка на блок.
  constraint template_line_shape check (
    (block_code is not null and material_name is null and analog_group_name is null)
    or (block_code is null and (material_name is not null or analog_group_name is not null))
  )
);

-- Шаблоны — общие для платформы, а не данные кабинета: тенанта у них нет.
-- RLS всё равно включаем, чтобы прямой клиент их не читал.
do $$
declare t text;
begin
  foreach t in array array['catalog_templates','template_units','template_materials',
    'template_analog_groups','template_analog_members','template_blocks',
    'template_block_lines','template_services','template_techcard_lines']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy %I on %I as restrictive for all to anon, authenticated using (false)',
                   t || '_deny_direct', t);
  end loop;
end $$;

-- ── Слепок действующего каталога ────────────────────────────────────────
--
-- Справочник терапевта не переписывается руками: он снимается с кабинета,
-- где уже отработал на 165 приёмах. Переписывание 53 материалов и 8 техкарт
-- заново означало бы новые опечатки в нормах расхода — а норма это деньги.
do $$
declare tpl uuid; t uuid;
begin
  select id into t from tenants order by created_at limit 1;
  if t is null then return; end if;   -- пустая база: шаблон приедет отдельным сидом

  insert into catalog_templates (code, name_ru, specialty)
       values ('therapist', 'Стоматолог-терапевт', 'therapist')
    returning id into tpl;

  insert into template_units (template_id, code, name_ru, name_uz, factor, divisible)
  select tpl, u.code, u.name_ru, u.name_uz, u.factor, u.divisible
    from units u where u.tenant_id = t;

  insert into template_materials (template_id, name_ru, name_uz, category, unit_code, reference_price)
  select tpl, m.name_ru, m.name_uz, m.category, u.code, m.reference_price
    from materials m join units u on u.id = m.base_unit_id
   where m.tenant_id = t;

  insert into template_analog_groups (template_id, name)
  select tpl, ag.name from analog_groups ag where ag.tenant_id = t;

  insert into template_analog_members (group_id, material_name, priority)
  select tg.id, m.name_ru, agm.priority
    from analog_group_members agm
    join analog_groups ag on ag.id = agm.group_id and ag.tenant_id = t
    join template_analog_groups tg on tg.template_id = tpl and tg.name = ag.name
    join materials m on m.id = agm.material_id;

  insert into template_blocks (template_id, code, name_ru, name_uz)
  select tpl, b.code, b.name_ru, b.name_uz
    from techcard_blocks b where b.tenant_id = t;

  -- Берём последнюю версию каждого блока: она и есть действующая норма.
  insert into template_block_lines (block_id, material_name, norm_qty, unit_code, scales_with_quantity)
  select tb.id, m.name_ru, bl.norm_qty, u.code, bl.scales_with_quantity
    from techcard_block_lines bl
    join techcard_block_versions bv on bv.id = bl.block_version_id
    join techcard_blocks b on b.id = bv.block_id and b.tenant_id = t
    join template_blocks tb on tb.template_id = tpl and tb.code = b.code
    join units u on u.id = bl.unit_id
    join materials m on m.id = bl.material_id
   where bv.version = (select max(v2.version) from techcard_block_versions v2 where v2.block_id = b.id);

  insert into template_services (template_id, code, name_ru, name_uz, price,
                                 unit_of_norm, duration_minutes, bookable, techcard_name_ru)
  select tpl, s.code, s.name_ru, s.name_uz, s.price,
         s.unit_of_norm, s.duration_minutes, s.bookable, tc.name_ru
    from services s
    left join techcard_versions tv on tv.id = s.techcard_version_id
    left join techcards tc on tc.id = tv.techcard_id
   where s.tenant_id = t;

  insert into template_techcard_lines (service_id, material_name, analog_group_name,
                                       block_code, norm_qty, unit_code, scales_with_quantity)
  select ts.id, m.name_ru, ag.name, b.code, tl.norm_qty, u.code, tl.scales_with_quantity
    from services s
    join template_services ts on ts.template_id = tpl and ts.name_ru = s.name_ru
    join techcard_lines tl on tl.techcard_version_id = s.techcard_version_id
    left join materials m on m.id = tl.material_id
    left join analog_groups ag on ag.id = tl.analog_group_id
    left join techcard_block_versions bv on bv.id = tl.block_version_id
    left join techcard_blocks b on b.id = bv.block_id
    left join units u on u.id = tl.unit_id
   where s.tenant_id = t;
end $$;;
