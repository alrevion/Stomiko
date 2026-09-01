-- Stomiko 002: единицы, материалы, партии, техкарты, услуги.

-- divisible = false → потребность округляется вверх до целой единицы.
-- Вскрытая ради 0.6 мл карпула стоит целиком: это реальная статья себестоимости.
create table units (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  code         text not null,
  name_ru      text not null,
  name_uz      text not null,
  base_unit_id uuid references units(id) on delete restrict,
  factor       numeric(18,6) not null default 1 check (factor > 0),
  divisible    boolean not null default true,
  unique (tenant_id, code)
);

create table materials (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  name_ru      text not null,
  name_uz      text not null,
  base_unit_id uuid not null references units(id) on delete restrict,
  category     text,
  -- Справочная цена — четвёртое звено контракта цены, до NULL+unpriced.
  reference_price numeric(18,2) check (reference_price is null or reference_price > 0),
  created_at   timestamptz not null default now()
);
create index materials_tenant_idx on materials (tenant_id);

create table analog_groups (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name      text not null
);

create table analog_group_members (
  group_id    uuid not null references analog_groups(id) on delete cascade,
  material_id uuid not null references materials(id) on delete restrict,
  priority    int  not null default 0,
  primary key (group_id, material_id)
);

-- qty_remaining — кэшированная проекция журнала движений, а не независимая истина.
-- Инвариант: qty_remaining = initial_qty + Σ(qty_delta по партии). Сверяется на
-- складском экране, а не только в тестах.
create table batches (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  location_id     uuid not null references locations(id) on delete restrict,
  material_id     uuid not null references materials(id) on delete restrict,
  initial_qty     numeric(18,6) not null check (initial_qty > 0),
  qty_remaining   numeric(18,6) not null check (qty_remaining >= 0),
  total_price     numeric(18,2) check (total_price is null or total_price > 0),
  price_estimated boolean not null default false,
  expires_at      date,
  supplier        text,
  created_at      timestamptz not null default now(),
  check (qty_remaining <= initial_qty)
);
-- Индекс под FEFO: непросроченные партии материала в порядке срока годности.
create index batches_fefo_idx on batches (tenant_id, location_id, material_id, expires_at nulls last, id);

-- Переиспользуемые блоки: базовый набор кресла (14 позиций), анестезия (4),
-- изоляция (4), рентген (3). Заводятся один раз и подключаются к десяткам карт —
-- иначе 76 карт × ~50 позиций = ~3000 строк вместо ~820.
create table techcard_blocks (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  code      text not null,
  name_ru   text not null,
  name_uz   text not null,
  unique (tenant_id, code)
);

create table techcard_block_versions (
  id         uuid primary key default gen_random_uuid(),
  block_id   uuid not null references techcard_blocks(id) on delete cascade,
  version    int  not null,
  created_at timestamptz not null default now(),
  unique (block_id, version)
);

-- Вложение блока в блок запрещено: строка ссылается только на материал или
-- группу аналогов. Глубина композиции ровно два уровня, циклы невозможны.
create table techcard_block_lines (
  id                 uuid primary key default gen_random_uuid(),
  block_version_id   uuid not null references techcard_block_versions(id) on delete cascade,
  material_id        uuid references materials(id) on delete restrict,
  analog_group_id    uuid references analog_groups(id) on delete restrict,
  norm_qty           numeric(18,6) not null check (norm_qty > 0),
  unit_id            uuid not null references units(id) on delete restrict,
  -- Строки блоков по умолчанию НЕ масштабируются на quantity: моляр с тремя
  -- каналами расходует втрое больше гипохлорита, но одну пару перчаток.
  scales_with_quantity boolean not null default false,
  check ((material_id is null) <> (analog_group_id is null))
);
create index techcard_block_lines_version_idx on techcard_block_lines (block_version_id);

create table techcards (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name_ru   text not null,
  name_uz   text not null
);

create table techcard_versions (
  id          uuid primary key default gen_random_uuid(),
  techcard_id uuid not null references techcards(id) on delete cascade,
  version     int  not null,
  created_at  timestamptz not null default now(),
  unique (techcard_id, version)
);

-- Ровно одна из трёх ссылок: материал, группа аналогов или блок.
create table techcard_lines (
  id                   uuid primary key default gen_random_uuid(),
  techcard_version_id  uuid not null references techcard_versions(id) on delete cascade,
  material_id          uuid references materials(id) on delete restrict,
  analog_group_id      uuid references analog_groups(id) on delete restrict,
  block_version_id     uuid references techcard_block_versions(id) on delete restrict,
  norm_qty             numeric(18,6) check (norm_qty is null or norm_qty > 0),
  unit_id              uuid references units(id) on delete restrict,
  scales_with_quantity boolean not null default true,
  check (
    (case when material_id     is not null then 1 else 0 end) +
    (case when analog_group_id is not null then 1 else 0 end) +
    (case when block_version_id is not null then 1 else 0 end) = 1
  ),
  -- У строки-блока нет собственной нормы: она приходит из строк блока.
  check ((block_version_id is null) = (norm_qty is not null))
);
create index techcard_lines_version_idx on techcard_lines (techcard_version_id);

-- Неизменяемый снимок. Внутрь скопированы состав группы аналогов, коэффициент
-- единицы, содержимое версий блоков и флаг масштабирования — на момент версии.
-- Ссылок на блок здесь не остаётся, резолвить на чтении нечего.
-- Группа аналогов НЕ резолвится в материал: он выбирается на закрытии по FEFO
-- внутри зафиксированного состава.
create table techcard_expanded (
  id                   uuid primary key default gen_random_uuid(),
  techcard_version_id  uuid not null references techcard_versions(id) on delete cascade,
  source               text not null check (source in ('line','block')),
  material_id          uuid references materials(id) on delete restrict,
  analog_group_id      uuid references analog_groups(id) on delete restrict,
  analog_material_ids  uuid[] not null default '{}',
  -- Норма уже сконвертирована в базовую единицу материала.
  norm_qty             numeric(18,6) not null check (norm_qty > 0),
  divisible            boolean not null,
  scales_with_quantity boolean not null,
  check ((material_id is null) <> (analog_group_id is null)),
  check ((analog_group_id is null) or array_length(analog_material_ids, 1) >= 1)
);
create index techcard_expanded_version_idx on techcard_expanded (techcard_version_id);

-- unit_of_norm: у эндодонтии единица — КАНАЛ, а не зуб. Привязка к зубу
-- систематически занижает себестоимость моляров — типовой дефект конкурентов.
create table services (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  code                text,
  name_ru             text not null,
  name_uz             text not null,
  price               numeric(18,2) not null check (price >= 0),
  unit_of_norm        text not null default 'tooth'
                        check (unit_of_norm in ('tooth','canal','surface','session','jaw')),
  techcard_version_id uuid references techcard_versions(id) on delete restrict,
  created_at          timestamptz not null default now()
);
create index services_tenant_idx on services (tenant_id);
